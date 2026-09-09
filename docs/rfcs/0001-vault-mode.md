# RFC 0001: vault mode — 文件夹是权威，SQLite 是派生索引

- 状态：已接受（基础已落地，见 §实施状态）
- 日期：2026-09-09
- 分支：`next`（main 的功能分支，见 §分支策略）
- 相关：RFC 0002（身份与增量 ingest）、RFC 0003（写回与冲突）

## 摘要

给 NoteFast 增加一种 notebook 类型 `kind = 'vault'`：把默认 notebook 绑定到用户的一个 Markdown 文件夹。文件夹是 source of truth，SQLite 只是可删可重建的派生索引；搜索、RAG、实体、AutoLink、MCP 照常工作，但永远跟随文件。

这不是重写、不是平行产品线。它是 `main` 上的一个 notebook 类型，与现有 `kind = 'db'`（SQLite 权威）共存于同一份代码，用 `VAULT_PATH` 启用。

## 动机

| 现状（`kind='db'`） | Obsidian 用户的真实需求 |
|---|---|
| SQLite 是权威 | 拥有真 `.md` 文件，能 git 跟踪、随时拷走 |
| shadow-markdown 是只读投影 | 在 Obsidian / vim / iOS 快捷指令里继续编辑 |
| 编辑器内置 | 不要被编辑器绑死 |

shadow-markdown（v0.86）解决了「能看见文件」，vault mode 解决「能改文件」。两者方向相反，目标用户不同，在代码里是两个互不相干的模块。

## 决策记录

### D1. 分支策略：`main` + notebook type，不做平行产品线

第一版草案把 `next` 做成独立包名（`@notefast-next/*`）的平行线。否决理由：

- 157 个文件的 import 改名让每次从 main cherry-pick 都冲突，「每两周同步一次 main」不可持续
- vault 与 db 的差异在 **notebook 粒度**上就能表达，没有任何东西需要分叉整包
- store / 搜索 / MCP / Web 阅读器全部零改动复用

现行做法：`next` 是 main 的普通功能分支，包名不变，按 `--ff-only` 合回 main。旧草案归档在 tag `archive/next-draft-20260909`。

### D2. 文档身份 = 文件路径；标题 = 文件名

- `vault_files.rel_path` 是文件身份（POSIX 相对路径）；一篇文档对应一个 `.md`
- 文档标题永远等于文件名去扩展名（Obsidian 心智：`[[wikilink]]` 按文件名解析）。正文首个与之同名的 H1 被剥离，与编辑器保存路径同一规则
- 不做「一个 `.md` 按 H1 切多篇」

### D3. 块身份 = 随机 UUID，稳定性靠对齐而非哈希

见 RFC 0002。要点：**不用内容哈希当 ID**。ingest 走与编辑器整篇保存完全相同的 `syncMarkdownChildren`，未变块保持 id，引用 / 向量 / 修订不作废。

### D4. 索引位置：不放进 vault

第一版草案把 `.notefast/index.sqlite` 放在 vault 内。否决：SQLite 落在 git / iCloud / Syncthing 同步目录里是损坏高发区。索引留在 `DATA_DIR`（原有位置），vault 里只放用户的文件，唯一例外是 `.trash/`（写回删除时移入，Obsidian 同名约定，被默认忽略）。

一个 `DATA_DIR` 只绑一个 vault；`notebooks.vault_root` 记录绑定，启动时路径不一致直接拒绝（不静默换绑）。

### D5. 写回默认关闭，先做「只读索引」

SQLite → 文件 的写回是双向同步的另一半，格式保真（Obsidian 私有语法、用户排版）没有解决之前不默认开启。MVP 默认 `VAULT_WRITEBACK=false`：NoteFast / MCP 端对 vault 文档的编辑只落索引，下一次文件变更会覆盖它。启动日志与 `/api/v1/vault/status` 都明示这一点。写回的完整设计见 RFC 0003。

### D6. vault 模式下关闭的能力

文件层已经承担了同步与备份，以下能力对 `kind='vault'` notebook 不再有意义，MVP 阶段**不调用**（不是禁用 UI，而是 ingest 路径不触发）：

- 多端同步协议（`scheduleSyncNow`）：ingest 不触发；同步交给 git / iCloud / Syncthing
- 欢迎文档种子：vault 模式启动不种（库里每篇文档都应对应一个文件）
- 整篇快照（`doc_snapshots`）：ingest 不记（历史在 git）

仍然照常工作：FTS、向量索引、实体 / AutoLink、MCP 全部工具、Web 阅读器、回收站。

## 三层模型

```
文件层（用户拥有）          VAULT_PATH/**/*.md                    ← 权威
        │ chokidar + reconcile
索引层（引擎拥有，可重建）   DATA_DIR/notefast.db
                             ├─ blocks / block_refs / FTS / vec   ← 与 db 模式同一套表
                             └─ vault_files                       ← 文件 ↔ 文档映射（RFC 0002）
        │ RAG / AutoLink / MCP
引用层（软解析）             [[wiki]] → rel_path → doc_id           ← 漂移时降级，不抛 broken link
```

## 写入策略

| 触发源 | 路径 |
|---|---|
| Obsidian / 任意工具改文件 | fs 事件 → 串行队列 → `ingestVaultFile` → 指纹对齐 → SQLite |
| 文件删除 | unlink 挂起 grace 窗口 → 无同 sha 的 add 出现 → 文档进回收站，映射打 `deleted_at` |
| 文件改名 / 移动 | unlink + add 同 sha 配对 → 只改 `rel_path` 与标题，块 / 引用 / 向量全保留 |
| 启动 / 手动 rebuild | `reconcileVault`：磁盘 vs 映射全量对账（新建 / 更新 / 移动 / 删除） |
| NoteFast / MCP / AI 改文档 | 默认只落索引；`VAULT_WRITEBACK=true` 时 → tmp+rename 写回（RFC 0003） |

所有写文件都是 `tmp + rename`。全部 vault 写路径共用一把串行锁，避免两次对齐读到过期子块。

## 实施状态

已落地（本 RFC 接受时）：

- 迁移 `023_vault_mode`：`notebooks.kind / vault_root` + `vault_files`
- `store/vaultFiles.ts`：映射表唯一读写入口
- `vault/`：`config` `paths` `writer` `lock` `ingest` `watcher` `writeback` `index`
- `/api/v1/vault/{status,files,rebuild,ingest}`
- `__tests__/vault.test.ts`：路径守卫、原子写与冲突、块 id 稳定、回收站与恢复、rename 配对保引用、全量对账、真实 fs watcher、写回回声 / 冲突 / 落盘 / 移入 .trash、路由

后续里程碑：

| 版本 | 内容 |
|---|---|
| v0.87 | 本 RFC 基础 + 写回（默认关）；`/api/v1/vault/*`；MCP `notefast_vault_status` |
| v0.88 | wikilink / `^block` 软解析进 `block_refs`（RFC 0002 §引用解析）；`assets/` 相对路径 ↔ `asset:<sha>` 映射 |
| v0.89 | 写回格式保真（RFC 0003 §按块局部 patch）；写回默认开 |
| 之后 | 桌面壳「打开文件夹为 vault」；Web 只读视图标记 vault 文档来源 |

## 非目标

- 不做 CRDT / 三方合并；冲突 = 拒绝覆盖 + 审计事件（RFC 0003）
- 不做 Obsidian 插件宇宙
- 不试图替代 Obsidian 的编辑体验
- 不支持一个实例挂多个 vault（单 notebook 原则）
- 不支持跨 vault 引用

## 开放问题

1. Web UI 是否要对 vault 文档禁用编辑器（写回关闭时编辑会被文件覆盖）？倾向：写回关闭时编辑器只读 + 提示「在外部工具中编辑」
2. `properties.ai_exclude` 在文件里如何表达？倾向 frontmatter `notefast_ai_exclude: true`，写回时保留
3. 大 vault（10k+）首次对账的进度暴露：`/status.reconciling` 已有，是否需要 SSE 进度
4. 符号链接：当前跳过链接目录、链接文件按 vault 内位置处理；是否需要 `VAULT_FOLLOW_SYMLINKS`
