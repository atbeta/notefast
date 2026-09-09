# RFC 0002: vault 模式下的身份与增量 ingest

- 状态：已接受（基础已落地）
- 依赖：RFC 0001
- 实现：`packages/server/src/vault/ingest.ts`、`store/vaultFiles.ts`、迁移 `023_vault_mode`

## 摘要

定义 vault 模式下三种身份（文件 / 文档 / 块）各自的载体与稳定性保证，以及文件变更到 SQLite 的增量流程。核心结论：**块 ID 是随机 UUID，稳定性来自对齐算法，不来自内容哈希**；文件 ↔ 文档的绑定由一张显式映射表承担。

## 第一版草案为什么被推翻

草案把块 ID 定义为 `sha256(file_path + heading_path + content_window±1)`。三个致命问题：

1. **内容哈希做 ID，内容一变 ID 必变**——「稳定」在定义上不成立。草案声称「纯打字错误不影响」是错的
2. **±1 行内容窗口让稳定性更差**：改一行同时改掉自己和上下邻居三个块的指纹；main 的 `planBlockAlign` 靠「精确匹配 + 空隙内同类型就地保留」已经提供编辑容忍，不需要邻居窗口
3. **`file_path` 进哈希与「改名 = 迁移索引」自相矛盾**：路径一变全部 ID 变，没有可迁移的东西

草案还把「对齐指纹」（临时匹配键）与「持久 ID」混为一体。main 的正确分层是：ID = UUID，指纹 = `type + content + props` 只在对齐瞬间使用。vault 模式沿用这一分层。

## 三种身份

| 身份 | 载体 | 稳定性 | 变更方式 |
|---|---|---|---|
| 文件 | `vault_files.rel_path`（POSIX 相对路径） | 用户控制 | rename 由 sha 配对迁移，不新建 |
| 文档 | `vault_files.doc_id` → `blocks.id`（type='document'） | 随映射行存在而稳定 | 仅文件消失且回收站清空后才丢失 |
| 块 | `blocks.id`（随机 UUID） | 对齐算法保证 | 未变块 100% 保持；就地编辑保持；只有真正新增的块拿新 id |

## `vault_files` 映射表

```sql
CREATE TABLE vault_files (
  notebook_id     TEXT NOT NULL REFERENCES notebooks(id) ON DELETE CASCADE,
  rel_path        TEXT NOT NULL,          -- 文件身份
  doc_id          TEXT NOT NULL UNIQUE,   -- 文档身份
  content_sha256  TEXT NOT NULL,          -- 变更短路 / 回声抑制 / rename 配对 / 写回乐观并发
  size            INTEGER NOT NULL,
  mtime_ms        INTEGER NOT NULL,
  ingested_at     TEXT NOT NULL,
  doc_updated_at  TEXT NOT NULL,          -- ingest 结束时 doc.updated_at；写回订阅者据此识别回声（RFC 0003）
  deleted_at      TEXT,                   -- 非空 = 文件已消失、文档在回收站
  frontmatter_raw TEXT,                   -- 用户手写 frontmatter 原文，写回行级透传（RFC 0003 阶段 B）
  meta_hash       TEXT,                   -- sha(tags + ai_exclude + status)，补齐 touchUpdatedAt:false 的回声盲区
  PRIMARY KEY (notebook_id, rel_path)
);
```

顶层块在正文中的位置另存 `vault_block_spans(doc_id, block_id, start, end, content_hash)`（RFC 0003 阶段 C）：按块局部写回靠它复用磁盘字节。未解析的 wikilink 目标存在 `vault_unresolved_links(notebook_id, source_block_id, target_name, anchor)`（§引用解析）。

`content_sha256` 一列承担四个职责，是整个设计里最重要的字段：

- **短路**：sha 未变 → `unchanged`，不解析不对齐（编辑器空保存、我们自己写回的回声都在这里被吞掉）
- **rename 配对**：unlink 后出现同 sha 的 add → 纯移动
- **重现恢复**：`deleted_at` 非空的行遇到同 sha 文件 → 恢复回收站里的文档而非新建
- **写回并发**：写文件前核对磁盘 sha 与此列，不等 = 外部改过 = 拒绝覆盖

## 增量 ingest 流程

```
ingestVaultFile(rel_path)
  ├─ 守卫：越界 / 非 .md / 忽略目录 → skipped
  ├─ 读文件 → sha；文件不在 → removeVaultFile
  ├─ 映射行存在且 sha 相同且文档活着 → unchanged
  ├─ 定位目标文档
  │    ├─ 同路径映射行 → 该文档（在回收站则先恢复 → restored）
  │    ├─ 无映射，但存在 deleted_at≠NULL 且同 sha 的行 → moveVaultFile → moved
  │    └─ 都没有 → insertDocFromMarkdown → created
  └─ 既有文档：
       ├─ 标题 = 文件名（变了才 update，noRevision）
       ├─ frontmatter tags → 文档 tags（不 bump updated_at）
       ├─ stripDocFrontmatter → parseMarkdownToBlocksForSave → stripTitleHeading
       ├─ syncMarkdownChildren（与 PUT /docs/:id/markdown 同一函数）
       ├─ deleteRefs / deleteMentions（仅被删块）
       ├─ upsertVaultFile(sha, doc_updated_at)
       └─ hooks：afterDelete / afterCreate / afterUpdate + scheduleDocIndex（只重索引变动块）
```

ingest **不做**：不记 `doc_snapshots`（历史在 git）、不触发多端同步、不写文件。

## 对齐算法（复用，不新写）

`services/blockAlign.ts#planBlockAlign`：

1. 按文档序做精确指纹匹配（`type + content + stablePropsJson`）
2. 匹配点之间的空隙里，旧块与新块**同类型则视为就地编辑**，保留 id、标记 `contentChanged`
3. 剩余的旧块删除、新块插入

因此：改一段文字 → 该块 id 保留、`updated` +1；中间插一段 → 旧块 id 全保留、`inserted` +1；整篇重写 → 大部分 id 漂移（正常）。测试 `vault.test.ts` 覆盖前两种。

## 删除、重现、改名

| 事件 | 处理 | 引用 / 向量 |
|---|---|---|
| 文件消失（grace 窗口内无配对） | 文档软删除进回收站；映射 `deleted_at` | 引用删除、向量清除（与 UI 删除一致） |
| 同路径同 sha 重现 | 恢复回收站文档 + 对齐（no-op） | 重新调度索引 |
| 同路径不同内容重现 | 恢复 + 对齐（真实差量） | 差量重索引 |
| unlink + add 同 sha（watcher 配对） | `moveVaultFilePath`：只改 rel_path 与标题 | **全部保留** |
| 全量对账里的改名 | 消失的映射 × 无映射的新文件，按 sha 配对 | 全部保留 |
| 回收站清空后文件重现 | 映射行清除，按新文档处理 | 重建 |

grace 窗口默认 `max(1000ms, stabilityMs × 3)`；窗口内文件在原路径回来（编辑器「删除后重建」保存策略）按普通变更处理。

## 全量对账（`reconcileVault`）

启动时先挂 watcher（不漏事件）再后台对账；`POST /api/v1/vault/rebuild` 手动触发。步骤：

1. 列磁盘 `.md`（跳过忽略目录与符号链接）
2. 消失的映射行 × 无映射的新文件，按 sha 配对 → move；配不上的 → 进回收站
3. 逐个 ingest（sha 短路使未变文件几乎零成本）

对账与 watcher 队列、写回共用一把串行锁；事件在对账期间排队，不会交错。

## 引用解析（已落地）

`[[Note]]`、`[[Note#Heading]]`、`[[Note#^abc123]]` 在 ingest 时解析为 `block_refs` 行，按最严到最宽降级：

1. `^abc123` 命中块级 `properties.obsidian_block_id`（Obsidian 用户自定义短码，不是我们的 UUID）
2. `#Heading` 命中该文档下 heading 块（slug 比较）
3. 文件名按 Obsidian「最短唯一路径」规则命中 `vault_files.rel_path`
4. 失败 → 不建 ref，记 `vault_unresolved_links` 供 UI 显示，不抛错

实现见 `vault/wikilinks.ts`（`ref_type='wikilink'`）。无锚点引用指向文档根 id（改名 / 移动天然保持）；带锚点引用优先指向命中块，锚点暂时找不到则退化为文档级引用并记 unresolved，目标文档补上 heading / 块 id 后自动升级。`vault_unresolved_links(notebook_id, source_block_id, target_name, anchor)` 随源块重写，目标文件出现 / 改名 / 从回收站恢复时按 `target_name` 反查补建。

## 验证标准

| 指标 | 目标 | 现状 |
|---|---|---|
| 改一段文字的块 id 保持率 | 100%（就地编辑） | 测试覆盖 |
| 中间插入一段的旧块 id 保持率 | 100% | 测试覆盖 |
| 改名 / 移动文件的引用保持率 | 100% | 测试覆盖 |
| 删除后同内容重现的文档 id 保持率 | 100%（回收站未清空） | 测试覆盖 |
| 1000 文件首次对账 | < 30s | 待测 |
| 文件变更 → SQLite 可见 | < stabilityMs + 200ms | 待测 |

## 风险

| 风险 | 缓解 |
|---|---|
| chokidar 在 macOS/Bun 偶发漏事件 | 启动对账 + 手动 rebuild 兜底；后续可加定时轻量对账（只比 mtime/size） |
| 用户在 NoteFast UI 删除 vault 文档但文件仍在 | 下一次文件变更会恢复文档；写回开启时 UI 删除会把文件移入 `.trash/` |
| 两个不同路径的文件内容完全相同 | 配对取最近删除的一条；误配只影响标题，不丢数据 |
| Obsidian 私有语法（callout / `%%` / `^id`）解析 | mdast 解析为普通段落 / 引用块，索引可用；写回保真见 RFC 0003 |
