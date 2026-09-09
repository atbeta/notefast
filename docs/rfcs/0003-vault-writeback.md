# RFC 0003: vault 写回与冲突

- 状态：草案（回声抑制、乐观并发、整篇写回已落地并默认关闭；格式保真未落地）
- 依赖：RFC 0001、RFC 0002
- 实现：`packages/server/src/vault/writeback.ts`、`vault/writer.ts`

## 问题

RFC 0001 说「文件是权威、单向跟随」，但 NoteFast 是 AI-first 产品：MCP `notefast_update_block`、AutoLink、AI 维护、Web 编辑器都会改 SQLite。若这些改动不写回文件，下一次外部编辑会**静默抹掉 AI 的工作**；若写回，就要面对双向同步的全部问题：回声、并发冲突、格式保真。

本 RFC 给出写回的范围、机制与分阶段策略。**默认关闭**（`VAULT_WRITEBACK=false`），开启前必须理解 §已知限制。

## 范围

写回订阅 `docEvents`（doc 级、300ms 聚合）。对 `kind='vault'` notebook 的文档：

| 事件 | 动作 |
|---|---|
| `created`（NoteFast / MCP 新建） | 标题 → 文件名（去掉 `\/:*?"<>\|` 与控制字符，重名追加 ` (n)`）→ 写到 vault 根 → 建映射 |
| `updated`（且非回声） | 序列化整篇 → `tmp + rename` 到映射路径 |
| `deleted` | 文件移入 `vault/.trash/`（Obsidian 同名约定，被忽略规则排除）；映射打 `deleted_at`，回收站恢复时按原路径写回 |

不写回：`ai_exclude`、`status`（inbox / note）、创建时间等 NoteFast 内部元数据（见 §开放问题）。

## 回声抑制

ingest 结束时把 `doc.updated_at` 记进 `vault_files.doc_updated_at`。写回收到 `updated` 事件时：

```
row.doc_updated_at === doc.updated_at  → 这次变更就是刚才的 ingest → 跳过（echo）
否则                                    → SQLite 端真实编辑 → 写回
```

写回成功后同样对齐 `doc_updated_at` 并刷新 `content_sha256`，于是紧随其后的 watcher 事件在 ingest 的 sha 短路处成为 `unchanged`。两个方向的回声都在各自入口被吞掉，不需要全局「正在写」标记。

## 乐观并发

写回前重读磁盘：

```
disk_sha === row.content_sha256   → 磁盘仍是我们上次见到的版本 → 写
disk_sha === next_sha             → 内容已一致 → 不写
否则                              → 外部工具在我们之后改过 → VaultConflictError
```

冲突时**不覆盖**，记审计事件 `doc.vault_writeback_conflict`（含 expected / actual sha），启动日志告警。此时磁盘版本会（或已经）被 watcher ingest，SQLite 端那次编辑就此丢失——这是「文件是权威」的直接推论，不做三方合并。

后续（未落地）：冲突时把 NoteFast 版本另存为 `<name>.notefast-conflict-<ts>.md` 交给用户处理（Syncthing / Obsidian Sync 的通行做法）。

## 序列化

`serializeVaultDoc`：

- 不输出 `# title`（标题即文件名，RFC 0001 D2）
- 仅在有标签时输出 Obsidian 兼容 frontmatter：`tags:` 列表
- 正文 = `blocksToMarkdown(root.children)`，末尾单个换行

## 已知限制：格式保真

整篇序列化会把用户的 Markdown 规范化：

- 空行数、列表缩进、强调符号（`*` vs `_`）等排版被统一
- 非 CommonMark 的 Obsidian 私有语法（callout `> [!note]`、`%%注释%%`、`^block-id`、`![[embed]]`、dataview 查询块）被 mdast 当普通段落 / 引用块处理，写回后可能改写
- 用户手写的 frontmatter 只保留 `tags`，其余字段丢失

这正是写回默认关闭的原因。对 Obsidian 用户而言「工具重排了我的文件」是零容忍事项。

## 阶段计划

| 阶段 | 内容 | 状态 |
|---|---|---|
| A | 回声抑制 + 乐观并发 + 整篇写回 + `.trash/`；默认关闭 | 已落地 |
| B | frontmatter 透传：ingest 时保留原始 frontmatter 文本（`vault_files.frontmatter_raw`），写回时只替换 `tags` 键 | 待做 |
| C | 按块局部 patch：ingest 记录每个顶层块在文件中的 `[start, end)` 行区间；写回只替换 `updatedIds` 对应区间的文本、在 `insertedIds` 的邻居后插入、删除 `deletedIds` 区间，其余字节原样保留 | 待做 |
| D | 冲突副本文件；写回默认开启 | 待做 |

C 完成前，Web 编辑器对 vault 文档的建议行为：写回关闭时只读 + 「在外部工具中编辑」提示（RFC 0001 开放问题 1）。

## 开放问题

1. `ai_exclude` / `status` 是否进 frontmatter（`notefast_ai_exclude: true` / `notefast_status: inbox`）？进则 Obsidian Properties 面板可见可改；不进则这两项只活在索引里，重建索引后丢失
2. 新建文档落盘位置：当前落 vault 根；是否需要 `VAULT_INBOX_DIR`（如 `inbox/`）让 MCP 新建的笔记集中
3. 写回是否应尊重 `.gitignore`（用户明确不想被跟踪的文件不写）
