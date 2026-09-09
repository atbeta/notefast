# RFC 0001: vault-mode — 文件作为权威、AI 作为衍生

- 状态：草案
- 作者：claw-mico
- 日期：2026-09-09
- 目标版本：NoteFast Next v0.1.0-next.0
- 适用分支：`next`（与 `main` 并行）

## 摘要

把 NoteFast 从"SQLite 是权威、Markdown 是导出"翻转为"用户 vault 文件夹是权威、SQLite 是派生索引"。AI/RAG/实体/搜索继续工作，但永远跟随文件变化。

本 RFC 不在 `main` 实现；`main` 继续走 shadow-markdown 路线（v0.86.1 已经引入）。vault-mode 是 `next` 分支上的平行尝试，针对愿意把 `.md` 文件当作 primary 的用户（Obsidian 用户群）。

## 动机

现有产品定位的根本张力：

| 当前 main (v0.86.1) | 用户真正的需求 |
|---|---|
| SQLite 是权威 | 拥有真 .md 文件，能 git 跟踪 |
| Markdown 是导出格式 | Markdown 是写作格式 |
| shadow-markdown 单向投影 | 在 Obsidian 里能继续编辑 |
| 编辑器内置 | 不要被编辑器绑死 |

shadow-markdown 是妥协：用户能在 Finder 里看到 `.md` 文件，但不能改。vault-mode 是相反路线：用户能改，SQLite 跟随。

## 目标

1. **用户拥有真文件**：vault 下的 `.md` 是 source of truth，能被任何工具编辑（Obsidian、VS Code、vim、iOS 快捷指令）
2. **AI 能力不丢失**：搜索、RAG、AutoLink、实体图谱、MCP 都还能用
3. **跨工具稳定引用**：文件身份稳定（路径）、块身份稳定（在 main v0.86 已用 blockAlign 实现）、引用跨工具可解析
4. **零冲突**：vault 永远不被 NoteFast 锁，AI 编辑通过 atomic rename 写回

## 非目标（明确不做）

- 不做双向 sync CRDT（接受"文件是权威，单向跟随"约束）
- 不做 Obsidian 插件宇宙（main 已经明确不做，next 也不做）
- 不替代 Obsidian 的编辑体验（不试图打败它的最强项）
- 不破坏 main 的语义（vault-mode 是平行特性，不污染老 API）

## 设计

### 三层抽象

```
┌────────────────────────────────────────────────────────┐
│ 文件层（用户拥有）                                       │
│ ~/Documents/notes/**/*.md                               │
│ assets/**/*.{png,jpg,...}                              │
└────────────────────────────────────────────────────────┘
                          ↑ file watch
┌────────────────────────────────────────────────────────┐
│ 索引层（引擎拥有，可删可重建）                             │
│ .notefast/index.sqlite   ← FTS5 + block refs + 元数据    │
│ .notefast/vectors.sqlite ← sqlite-vec                   │
│ .notefast/entities.json  ← 实体缓存                      │
│ .notefast/config.json    ← vault 配置                   │
└────────────────────────────────────────────────────────┘
                          ↑ RAG / AutoLink
┌────────────────────────────────────────────────────────┐
│ 引用层（语义层）                                          │
│ [[wiki]]               →  (file, block_hash)             │
│ [[wiki#heading]]       →  (file, heading_slug)           │
│ block_refs 表行         →  (src, dst, type, weight)       │
└────────────────────────────────────────────────────────┘
```

### 三种标识，三种稳定性

| 标识 | 算法 | 稳定性 |
|---|---|---|
| 文件身份 | vault 相对路径 | 用户控制；改名 = 一次性迁移 |
| 块身份 | `sha256(path + heading_path + content_window_hash)` | 容忍就近编辑；大改后漂移（重链即可） |
| 引用 | `(src_id, dst_path, dst_anchor)` | 软解析，漂移降级到 heading 锚 |

### 写入策略

| 触发源 | 流程 |
|---|---|
| 用户在 NoteFast 编辑器里写 | editor → file (atomic rename) → watcher → indexer → SQLite |
| 用户在 Obsidian 里写 | file 变更 → watcher → indexer → SQLite |
| AI 改写（RAG / AutoLink） | engine → file (atomic rename) → watcher → indexer → SQLite |
| 删除文件 | watcher → SQLite 标记 stale → 30 天后真删（防误删） |

所有写文件都用 `tmp + rename`，原子性由文件系统保证。无锁、无 CRDT、无冲突。

### 增量索引流程

```
file change detected (chokidar)
  ↓
parse .md → blocks (复用 packages/core/markdownParse.ts)
  ↓
compute block IDs (复用 packages/core/contentHash.ts + 新算法)
  ↓
align with existing blocks (复用 packages/server/services/blockAlign.ts)
  ↓
diff: keep / insert / update / delete
  ↓
apply to SQLite via store/blocks.ts (已稳定接口)
  ↓
schedule FTS5 reindex (增量)
  ↓
schedule vector re-embed (仅 changed blocks)
  ↓
emit doc event (订阅者刷新 UI)
```

`blockAlign.ts` 和 `markdownChildSync.ts` 在 main v0.86 已经实现，**vault-mode 直接复用**——这大幅降低工作量。

## 迁移路径

`next` 分支起步阶段（v0.1.0-next.x）：

1. 新增 vault 配置（`VAULT_PATH` 环境变量 + `config.json` 持久化）
2. 新增 `/api/v1/vault/*` 端点（注册、状态查询、手动重建索引）
3. 新增 `packages/server/src/vault/` 模块（adapter + watcher + ingest）
4. 新增 chokidar PoC（独立工具，不进产品）
5. **不**改写 web 前端，先用 API + CLI 验证
6. **不**改 main 现有 API，老用户无感

`next` v0.3.0-next.x：可选 web UI（"Open as Vault" 入口，只读视图）

`next` v0.5.0-next.x：完整 vault 模式（编辑器、auto-save、wiki-link autocomplete）

## 风险与决策点

### 必须先回答的问题

1. **doc 粒度**：一个 `.md` = 一个 doc，还是 H1 分段成多 doc？
   - 推荐：前者（最简单，符合 Obsidian 心智）
2. **vault 嵌套**：vault 下面再开子文件夹当独立 notebook？
   - 推荐：嵌套是文件夹，不是 notebook（用 tags 区分）
3. **跨 vault 引用**：两个 vault 之间的 `[[link]]` 怎么处理？
   - 推荐：MVP 不支持，warn
4. **资产（图片等）位置**：
   - 推荐：vault 下的 `assets/` 子目录，Markdown 用相对路径（Obsidian 兼容）

### 已知风险

| 风险 | 缓解 |
|---|---|
| chokidar 跨平台 fs 行为差异 | 用 macOS/Linux 先验证，Windows 后做 |
| Obsidian 自己改 frontmatter | frontmatter 解析按 main 已有的实现 |
| vault 10k+ 文件索引慢 | 已存在的 archive / ai_exclude 机制可以分层 |
| iCloud / Syncthing 同步冲突 | 文件系统层面解决，NoteFast 不介入 |

## 与 shadow-markdown 的关系

shadow-markdown（main v0.86 引入）是**反方向**：SQLite → 文件系统，单向投影。用户能在 Finder 看但不能改。

vault-mode（next）是**正方向**：文件系统 → SQLite，单向跟随。用户能改，SQLite 跟随。

两个特性的目标用户群不一样：
- shadow-markdown：NoteFast 用户，偶尔想用其他工具**查看**笔记
- vault-mode：Obsidian 用户，想**继续用 Obsidian**同时获得 NoteFast 的 AI

`next` 分支可以**同时支持两种模式**（一个实例可挂多个 notebook：type=sqlite、type=shadow、type=vault），但 MVP 阶段只实现 vault。

## 工作量估算（更新版）

基于 main v0.86 已经实现 `blockAlign` + `markdownChildSync` + `contentHash` + `shadowMarkdown` 的基础：

| 模块 | 人天 | 备注 |
|---|---|---|
| vault adapter + 配置 | 2-3 | |
| chokidar watcher | 2-3 | 复用 PoC 经验 |
| ingest 流程（parse → align → apply） | 3-4 | 复用 blockAlign/markdownChildSync |
| `/api/v1/vault/*` 端点 | 1-2 | |
| 前端只读视图（v0.3） | 3-5 | |
| 编辑器集成（v0.5） | 5-8 | 暂不做 |
| 文档 + 测试 + i18n | 3-4 | |
| **合计 v0.1 最小可用** | **约 10-15 人天** | |

比 RFC 初版（14-21 天）更小，因为基础设施已就位。

## 开放问题

1. 是否引入 `notefast:` URL scheme 让 Obsidian 插件能跳转回 NoteFast？
2. vault 模式下，老 SQLite notebook 是否还能用？（建议：能，作为 fallback）
3. 用户已有 vault 里有些 `.md` 文件含 HTML 残留、frontmatter 不规范，import 时如何处理？
4. AutoLink 在 vault 模式下行为：跑得过频繁？是否默认关？

## 参考

- main v0.86 `shadowMarkdown.ts` — 反方向实现，可借鉴订阅事件机制
- main v0.86 `blockAlign.ts` + `markdownChildSync.ts` — block ID 稳定性已解决
- main v0.86 `contentHash.ts` — 内容寻址 hash
- commit `789a703` — 历史上 wikilink 承诺被撤回的痕迹
