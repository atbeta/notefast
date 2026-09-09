# RFC 0003: vault 写回与冲突

- 状态：已接受，分阶段实施（A 已落地且默认开启；B–D 是发布门禁，见 `docs/plans/vault-mode.md` M2）
- 依赖：RFC 0001、RFC 0002
- 实现：`packages/server/src/vault/writeback.ts`、`vault/writer.ts`

## 问题

RFC 0001 说「文件是权威、单向跟随」，但 NoteFast 是 AI-first 产品：MCP `notefast_update_block`、AutoLink、AI 维护、Web 编辑器都会改 SQLite。若这些改动不写回文件，下一次外部编辑会**静默抹掉 AI 的工作**；若写回，就要面对双向同步的全部问题：回声、并发冲突、格式保真。

本 RFC 给出写回的范围、机制与分阶段策略。**默认开启**（RFC 0001 D5）；§已知限制里的格式保真问题由阶段 B/C 解决，解决前不发布可用版本。

## 范围

写回订阅 `docEvents`（doc 级、300ms 聚合）。对 `kind='vault'` notebook 的文档：

| 事件 | 动作 |
|---|---|
| `created`（NoteFast / MCP 新建） | 标题 → 文件名（去掉 `\/:*?"<>\|` 与控制字符，重名追加 ` (n)`）→ 写到 vault 根 → 建映射 |
| `updated`（且非回声） | 按块局部改写（阶段 C）；拿不到完整区间记录时退回整篇序列化 |
| `deleted` | 文件移入 `vault/.trash/`（Obsidian 同名约定，被忽略规则排除）；映射打 `deleted_at`，回收站恢复时按原路径写回 |

元数据（RFC 0001 D8）：`tags` / `notefast_ai_exclude` / `notefast_status` 写进 frontmatter；创建 / 修改时间不写（文件系统与 git 已有）。

**元数据变更的回声判定陷阱**：`updateBlock` 对 tags / ai_exclude 用 `touchUpdatedAt: false`，`doc.updated_at` 不变，§回声抑制会把它误判成回声而跳过。阶段 B 让 `vault_files` 额外记录 `meta_hash = sha(tags + ai_exclude + status)`，写回判定改为 `doc_updated_at 相同 且 meta_hash 相同` 才算回声。

**元数据变更必须发 doc 级事件**：`touchUpdatedAt: false` 的写入不经过 block 级 `afterUpdate` 钩子，而 doc 级事件总线（SSE、写回）只订阅那些钩子。因此 `PATCH /docs/:id/tags` 与 `PATCH /docs/:id/ai-exclude` 在写库后显式 `publishDocChange(id, 'updated')`；漏掉这步的症状是「NoteFast 改了元数据，文件永远不更新」。

## 回声抑制

ingest 结束时把 `doc.updated_at` 与 `meta_hash` 记进 `vault_files`。写回收到 `updated` 事件时：

```
row.doc_updated_at === doc.updated_at 且 row.meta_hash === 当前元数据指纹
  → 这次变更就是刚才的 ingest → 跳过（echo）
否则 → SQLite 端真实编辑（含只改标签 / ai_exclude）→ 写回
```

写回成功后同样对齐 `doc_updated_at` 并刷新 `content_sha256`，于是紧随其后的 watcher 事件在 ingest 的 sha 短路处成为 `unchanged`。两个方向的回声都在各自入口被吞掉，不需要全局「正在写」标记。

## 乐观并发

写回前重读磁盘：

```
disk_sha === row.content_sha256   → 磁盘仍是我们上次见到的版本 → 写
disk_sha === next_sha             → 内容已一致 → 不写
否则                              → 外部工具在我们之后改过 → VaultConflictError
```

冲突时**不覆盖**用户文件，把 NoteFast 版本另存为同目录 `<stem>.notefast-conflict-<yyyyMMdd-HHmmss>.md`（tmp+rename），记审计 `doc.vault_writeback_conflict`（含 expected / actual sha 与 `conflict_path`）。副本会被 watcher 当新文档 ingest —— 这是预期：用户看得见、可自行合并，NoteFast 端那次编辑不再无声丢失。磁盘版本同样会被 watcher ingest，仍然是「文件是权威」，不做三方合并。

`/api/v1/vault/status.conflicts` 暴露最近 24h 冲突计数与最近 10 条副本路径（读 `app_logs`），前端在 V-402 呈现。

## 序列化

`serializeVaultDoc`：

- 不输出 `# title`（标题即文件名，RFC 0001 D2）
- frontmatter = `patchFrontmatter(row.frontmatter_raw, patch)` 行级透传：只增删改 `tags` / `notefast_ai_exclude` / `notefast_status` 三键，用户手写的其余字段（aliases、cssclasses、自定义键）逐字节保留；无标签且无 NoteFast 元数据时不输出 frontmatter
- 正文 = 局部改写（阶段 C，见下节）；退回整篇时 = `blocksToMarkdown(root.children)` + 末尾单个换行

## 按块局部写回（阶段 C）

写回不再默认整篇序列化。`vault_block_spans(doc_id, block_id, start, end, content_hash)` 记录每个**顶层块**在正文中的 `[start, end)` 行区间，以及记录当时的**子树指纹**（类型 + 内容 + properties + 子块）。每次 ingest / 写回整表重写，因此「表非空」即完整快照。

```
指纹未变   → 直接复制磁盘旧字节（不重新序列化）
指纹变了   → 用 blocksToMarkdown 序列化该块，替换其区间
块不在表里 → 新增块，插到前驱块之后
旧块不在库 → 删除，区间随组装自然消失
```

块之间的空行：相邻且顺序未变的两个块之间照搬旧缝隙（不规则空行、行尾空格都保住），其余接缝用 `\n\n`。

为什么要指纹而不是「比较序列化文本」：mdast 会把 `_x_` 归一成 `*x*`、把独占行 `$$…$$` 渲染成 ```math 围栏。没有指纹基线时，未被用户改动的块也会被判为「变了」，整篇被重排。

区间偏移按**行号**换算（块首行行首 → 块末行行尾），因为 `$$` → ```math 的改写会改变字符长度但不改变行数。

兜底：区间缺失、越界、重叠，或解析结果与 DB 顶层块对不上 → 退回整篇序列化并记审计 `doc.vault_written_full`（`doc.vault_written` 带 `mode`）。已知触发面：含嵌套列表的文档在整篇写回后无法重建区间——现行序列化器把嵌套项拍平（语料 `21-nested-list` 冻结），重解析块数与 DB 不符，于是这类文档持续走整篇写回。

## 已知限制：格式保真

整篇序列化会把用户的 Markdown 规范化：

- 空行数、列表缩进、强调符号（`*` vs `_`）等排版被统一
- 非 CommonMark 的 Obsidian 私有语法（callout `> [!note]`、`%%注释%%`、`^block-id`、`![[embed]]`、dataview 查询块）被 mdast 当普通段落 / 引用块处理，写回后可能改写
- ~~用户手写的 frontmatter 只保留 `tags`，其余字段丢失~~ → 阶段 B 已修复：`vault_files.frontmatter_raw` 行级透传
- ~~未被编辑的块也被重新序列化~~ → 阶段 C 已修复：未改动块复用磁盘字节；**被编辑的那个块**仍会被归一化（V-304 负责收敛）

对 Obsidian 用户而言「工具重排了我的文件」是零容忍事项，所以 B/C 是发布门禁。

## 阶段计划

| 阶段 | 内容 | 状态 |
|---|---|---|
| A | 回声抑制 + 乐观并发 + 整篇写回 + `.trash/` | 已落地，默认开启 |
| B | frontmatter 透传：ingest 保留原始 frontmatter 文本（`vault_files.frontmatter_raw`），写回只增删改 `tags` / `notefast_ai_exclude` / `notefast_status` 三键；`meta_hash` 修正回声判定 | 已落地（`5369b8f` 等） |
| C | 按块局部 patch：`vault_block_spans` 记录顶层块区间与子树指纹，未改动块复用磁盘字节，区间失效退回整篇 | 已落地 |
| D | 冲突副本 `<name>.notefast-conflict-<ts>.md` | 已落地 |

## 开放问题

1. ~~`ai_exclude` / `status` 是否进 frontmatter~~ → 进（RFC 0001 D8）
2. 新建文档落盘位置：当前落 vault 根；是否需要 `VAULT_INBOX_DIR`（如 `inbox/`）让 MCP 新建的笔记集中
3. 写回是否应尊重 `.gitignore`（用户明确不想被跟踪的文件不写）
