# vault mode 开发计划（`next` 分支）

面向执行 Agent 的工作分解。每个任务自带目标、涉及文件、实现要点、验收标准与依赖，可以独立领取。领取前先读 §开工必读，完成后按 §完成定义收口。

- 状态维护：完成一项就把表格里的状态改掉并附 commit 短 hash；新发现的决策写进对应 RFC，不写在这里
- 决策来源：`docs/rfcs/0001-vault-mode.md`（D1–D8）、`0002-block-identity.md`、`0003-vault-writeback.md`
- 发布门禁：**M2 全部完成**才允许发首个可用版本（RFC 0001 D5）

## 开工必读

1. `AGENTS.md`（仓库纪律：store 旁路、i18n 双语对齐、tokens、commit 规范）
2. 三份 RFC，重点是 RFC 0002 §`vault_files`（`content_sha256` 的四重职责）与 RFC 0003 §回声抑制
3. 代码入口：`packages/server/src/vault/index.ts` → `ingest.ts` → `writeback.ts`；映射表只在 `store/vaultFiles.ts`
4. 现有测试：`packages/server/src/__tests__/vault.test.ts`（22 例，是行为规范，改行为先改测试）

```bash
bun install
bun --filter @notefast/server test src/__tests__/vault.test.ts   # 快速回归
bun lint && bun run typecheck && bun test                         # 提交前门禁
VAULT_PATH=/tmp/v DATA_DIR=/tmp/d PORT=3999 bun --filter @notefast/server dev   # 手工验证
```

### 已知坑（改 vault 代码前过一遍）

- `BlockRow` 类型没有 `is_deleted`；用 `getLiveBlockById` / `getDeletedBlockById` 区分，不要读 `row.is_deleted`
- `updateBlock` 对 tags / ai_exclude 用 `touchUpdatedAt: false`，`doc.updated_at` 不变 → 写回的回声判定会误判（V-202 修）
- `services/hooks.auditDocAction` 内部会 `scheduleSyncNow()`；vault 代码只用 `vault/audit.ts#auditVault`
- 所有 vault 写路径必须包在 `ctx.lock(...)` 里；watcher 队列、reconcile、writeback 已包，新增入口照做
- docEvents 300ms 聚合；测试里直接调 `writeback.handle(ev)`，不要等定时器
- `bun test` 单进程共享 env：改 `process.env` 必须 save/restore，还原用 `delete`
- 所有临时文件放 `/tmp`，不要在仓库里留 fixture 目录
- macOS 上 `/tmp`、`/var/folders` 经符号链接（→ `/private/...`），FSEvents / `fs.watch` **不投递事件**（Node 与 Bun 都是）；涉及真实监听的测试用 `usePolling: true`（`makeConfig` 已默认），手工验证用 `$HOME` 下的目录
- web 文案改动：`zh-CN` 与 `en` 同 key 同行号，`bun lint` 会查

## 里程碑总览

| 里程碑 | 目标 | 任务 | 状态 |
|---|---|---|---|
| M1 基础 | 文件 → 索引闭环 + 整篇写回 | — | 完成（`c4f9e2c` `b14d6c5`） |
| M2 写回保真 | 用户文件字节级不被无故改写 | V-201 … V-205 | **完成**（V-201 ✅ V-202 ✅ V-203 ✅ V-204 ✅ V-205 ✅） |
| M3 引用与资产 | wikilink / 块锚 / 图片在索引层可用 | V-301 … V-304 | V-301 ✅ V-304 ✅ |
| M4 体验 | MCP / Web / 桌面壳 / 自愈 | V-401 … V-404 | V-401 ✅ |
| M5 发布 | 性能、迁移、Docker、版本 | V-501 … V-504 | |

依赖关系：V-201 → V-202 → V-203 → V-204；V-203 依赖 V-304（解析器要能无损识别 Obsidian 语法，否则区间对不上）；V-301/302 可与 M2 并行；V-303 独立；M4 依赖 M2 完成；M5 最后。

---

## M2 写回保真（RFC 0003 B–D）—— 已全部完成，发布门禁解除

### V-201 frontmatter 透传

- **目标**：用户手写的 frontmatter 字段（aliases、cssclasses、任意自定义键）在写回后原样保留；NoteFast 只增删改自己的三个键
- **文件**：`packages/core/src/frontmatter.ts`、`packages/server/src/migrations/024_vault_frontmatter.ts`、`store/vaultFiles.ts`、`vault/ingest.ts`、`vault/writeback.ts`
- **要点**
  - 迁移 024：`vault_files` 加 `frontmatter_raw TEXT`（去掉首尾 `---` 的原文，无则 NULL）
  - `stripDocFrontmatter` 返回值增加 `raw`（原始 YAML 文本），不改现有调用方语义
  - 新增 `patchFrontmatter(raw: string | null, patch: { tags?: string[]; notefast_ai_exclude?: boolean; notefast_status?: 'inbox' | 'note' })`：行级替换/插入/删除这三个键，其余行零改动；`tags` 兼容 Obsidian 三种写法（块列表、`tags: [a, b]`、`tag:` 单数）读，写统一用块列表；补齐 `tags` 读取的三种写法
  - `serializeVaultDoc` 改为 `patchFrontmatter(row.frontmatter_raw, …) + body`；缺省值（`ai_exclude=false`、`status=note`）不写键，已有键则删掉
- **验收**：测试——含 `aliases: [x]` 与自定义键的文件 ingest → 改一个块 → 写回后 frontmatter 除 `tags` 外逐字节相同；`tags: [a, b]` 内联写法能入库；无 frontmatter 且无标签的文件写回后仍无 frontmatter
- **依赖**：无 · **估算**：1.5 人天
- **状态**：完成（`5369b8f`）。`meta_hash` 列随迁移 024 建好，逻辑留 V-202
  - 落地口径：`parseSimpleFrontmatter` 的 tags 只解引号、不做归一化（三种写法一致），小写 / 空格折叠仍由 `ingest.ts`、`docImport.ts` 的 `normalizeTagList` 负责
  - 测试：`core/src/__tests__/frontmatter.test.ts`（`raw`、三种写法、`patchFrontmatter` 全分支）、`server/src/__tests__/vault.test.ts`（透传逐字节、内联入库、清空标签只删 `tags` 键、无 frontmatter 保持无）

### V-202 `ai_exclude` / `status` 双向 + 元数据回声修正

- **目标**：RFC 0001 D8 落地；在 Obsidian 里改 `notefast_ai_exclude: true` 生效，在 NoteFast 里切 ai_exclude / 移入收集箱写回文件
- **文件**：`vault/ingest.ts`、`vault/writeback.ts`、`store/vaultFiles.ts`、迁移 024（与 V-201 合并）、`ai/aiExclude.ts`（只读，复用 `applyAiExcludeChange`）
- **要点**
  - ingest：读 `notefast_ai_exclude` / `notefast_status`，与文档当前值不同时调用既有写入函数（ai_exclude 变更必须走 `applyAiExcludeChange` 让向量随之增删；status 走 `updateBlock({ status })` + `fireDocAfterStatusChange`）
  - `vault_files` 加 `meta_hash TEXT`（`sha256(JSON[tags, ai_exclude, status])`），ingest 与写回后都刷新
  - 写回回声判定改为：`doc_updated_at` 相同 **且** `meta_hash` 相同 → 跳过
- **验收**：测试——文件里加 `notefast_ai_exclude: true` → ingest 后 `readDocAiExclude` 为真且该文档向量被清；UI 侧 `PATCH ai_exclude`（直接调 `writeDocAiExclude` + `handle(ev)`）→ 文件出现该键；反向切回 false → 键被删除；纯回声（ingest 后立刻 handle）仍 `skipped/echo`
- **依赖**：V-201 · **估算**：1 人天
- **状态**：完成（`cc5d389`）
  - 元数据读取与指纹收敛到新模块 `vault/meta.ts`（`readVaultDocMeta` / `vaultMetaHash` / `desiredStatusFromFile`），ingest 与 writeback 共用同一套口径
  - **超出原文件清单的两处必要改动**：① `api/docs.ts` 的 tags / ai_exclude 两个 PATCH 之前不发任何 doc 级事件（`touchUpdatedAt:false` 不触发 block 钩子），写回永远收不到通知 → 补 `publishDocChange(id, 'updated')`；② `parseSimpleFrontmatter` 对「只有用户自定义字段」的 frontmatter 返回 null，导致整段 YAML 被当正文入库 → 按「全部行都像 YAML 才认」修正
  - **archived 语义**：文件无法表达 archived，缺键时不降级（`desiredStatusFromFile`），写回也不写该键
  - **未做**：文件改 status 不走 API 路径的分享级联与 `reanalyzeDoc`（见「待议」）

### V-203 按块局部 patch

- **目标**：写回只改动被编辑的块所在行区间，文件其余字节原样保留（发布门禁的核心）
- **文件**：`packages/core/src/markdown/parseMdast.ts`（暴露顶层块 `position` 偏移）、`packages/core/src/markdown.ts`、`services/markdownParse.ts`、迁移 025（`vault_block_spans` 或 `vault_files.spans_json`）、`vault/ingest.ts`、`vault/writeback.ts`、新增 `vault/patch.ts`
- **要点**
  - 解析：`parseMarkdownToBlocksForSave` 旁增 `parseMarkdownWithSpans`，返回每个**顶层** `CreateBlockInput` 在 body 中的 `[startOffset, endOffset)`（mdast `position` 已有，见 `parseMdast.ts:239`）；frontmatter 长度单独记
  - 存储：ingest 后把 `blockId → span` 存下来（建议独立表 `vault_block_spans(doc_id, block_id, start, end, PRIMARY KEY(doc_id, block_id))`，随 ingest 整表重写）
  - 写回算法（`vault/patch.ts`）：以 `syncMarkdownChildren` 返回的 `insertedIds / updatedIds / deletedIds` 为输入，在**当前磁盘内容**（sha 已核对等于 `content_sha256`）上做区间编辑：updated → 用 `blocksToMarkdown([block])` 替换区间；deleted → 删区间及其后一个块间空行；inserted → 在前驱块区间末尾后插入 `\n\n` + 序列化；从后往前应用避免偏移漂移；子块变更归到其顶层祖先
  - 兜底：无 span 记录、区间越界、或任何断言失败 → 退回整篇序列化并记审计 `doc.vault_written_full`
  - 写回后重新 ingest 一次以刷新 spans（或直接按 patch 结果重算）
- **验收**：测试——fixture 含 callout `> [!note]`、`%%注释%%`、行尾 `^abc123`、`![[img.png]]`、不规则空行与 `*`/`_` 混用；ingest → `updateBlock` 改第二段 → 写回 → 除第二段区间外字节全等；插入 / 删除各一例；spans 缺失时退回整篇且有审计事件
- **依赖**：V-201、V-304 · **估算**：3 人天
- **状态**：完成（`adfb22f`）
  - 落地口径：迁移 025 建 `vault_block_spans(doc_id, block_id, start, end, content_hash)`，每次 ingest / 写回**整表重写**（表非空 = 完整快照，写回才能把「无区间」判为新增块而非记录残缺）
  - `content_hash` 是块子树指纹（类型 + 内容 + properties + 子块）：只看序列化文本无法区分「用户改了」与「mdast 归一化」
  - 区间偏移 = 「块首行行首 → 块末行行尾」，按**行号**换算以规避 `$$` → ```math 改写的长度漂移；顶层列表项连同嵌套子项是一个块
  - 组装：指纹未变的块复制旧字节；相邻且顺序未变的块复制它们之间的旧空行；其余接缝用 `\n\n`。首块前 / 末块后的空白仅在仍是原首 / 原末块时照搬
  - 兜底：区间缺失 / 越界 / 与 DB 顶层块对不上 → 整篇序列化 + 审计 `doc.vault_written_full`；`doc.vault_written` 带 `mode: patch | full`
  - 冲突判定前移到读盘后：外部改过的文件不参与解析
  - **依赖偏离**：未等 V-304 即落地。理由：不变区域从不重新序列化，本任务验收（除被改块外字节全等）不依赖解析器无损；V-304 仍影响「被编辑块」的保真与 V-302 的 `^id` 往返
  - **已知限制**：整篇退回后，含嵌套列表的文档无法重建区间（现行序列化器拍平嵌套项，语料 `21-nested-list` 已冻结）→ 这类文档持续走整篇写回，不会产生重复块；局部写回路径不受影响
  - 测试：`core/parseMdastSpans.test.ts`（区间切回源码、`$$` 不漂移、`bodyOnly`）、`vault.test.ts`（改 / 插 / 删 / 嵌套子块、缺失与越界退回、审计计数）

### V-204 冲突副本

- **目标**：写回冲突时不丢 NoteFast 端内容
- **文件**：`vault/writeback.ts`、`vault/writer.ts`
- **要点**：`VaultConflictError` 时把序列化结果写到同目录 `<stem>.notefast-conflict-<yyyyMMdd-HHmmss>.md`（tmp+rename），审计 `doc.vault_writeback_conflict` 附 `conflict_path`；该文件会被 watcher 当新文档 ingest，这是预期（用户可见）；`/api/v1/vault/status` 增加 `conflicts`（最近 24h 计数 + 最近 10 条路径）
- **验收**：测试——制造冲突 → 副本存在且内容为 NoteFast 版本 → 原文件未动 → status.conflicts 计数 1
- **依赖**：V-203 · **估算**：0.5 人天
- **状态**：完成（`7836a45`）
  - 副本落同目录 `<stem>.notefast-conflict-<yyyyMMdd-HHmmss>.md`，同秒多次冲突追加 `-2`/`-3` 不覆盖；写失败只 warn，不影响冲突判定
  - 两条冲突路径（读盘 sha 不符、写入瞬间的乐观并发）共用同一出口，审计附 `conflict_path`
  - `status.conflicts` = 从 `app_logs` 读 `doc.vault_writeback_conflict`：24h 计数 + 最近 10 条 `conflict_path`

### V-205 编辑器整篇保存经写回验证

- **目标**：Web 编辑器 `PUT /docs/:id/markdown` 对 vault 文档端到端正确：保存 → 写回 → watcher 回声 → 无第二次对齐
- **文件**：`__tests__/vault.test.ts`（新增用例）、必要时 `api/docs.ts#applyMarkdownReplace`
- **要点**：vault 文档保存不记 `doc_snapshots`（RFC 0001 D6；用 `getNotebookVaultBinding` 判定）；`scheduleSyncNow` 对 vault notebook 静默
- **验收**：测试——ingest → 经 Hono `app.request` PUT 新 markdown → `handle(ev)` 写回 → 文件内容符合 → 再 ingest 为 `unchanged`；`doc_snapshots` 无新行
- **依赖**：V-203 · **估算**：0.5 人天
- **状态**：完成（`475c8fc`）
  - `applyMarkdownReplace` 按 `getNotebookVaultBinding(...).kind === 'vault'` 判定（不是看环境变量：同一进程可换 `DATA_DIR`）：vault 文档跳过 `recordDocSnapshot` 与 `scheduleSyncNow`
  - 保存本身已发 doc 级事件（`fireAfterUpdate`），写回照常触发

---

## M3 引用与资产

### V-301 wikilink → `block_refs`

- **目标**：`[[Note]]`、`[[folder/Note]]`、`[[Note|alias]]` 在 ingest 时建立块 → 文档引用；反链页可见
- **文件**：新增 `vault/wikilinks.ts`、`vault/ingest.ts`、`store/refs.ts`（复用 `insertRef` / `deleteRefsFromSource`）、迁移 026（`vault_unresolved_links(notebook_id, source_block_id, target_name, anchor, PRIMARY KEY(source_block_id, target_name, anchor))`）
- **要点**
  - 解析块 `content` 中的 `[[...]]`（排除代码块与行内代码）；目标名按 Obsidian「最短唯一路径」解析：先精确 rel_path（补 `.md`），再全 vault 唯一 basename，再 basename 忽略大小写；多义 → 不建 ref 并记 unresolved
  - `ref_type = 'wikilink'`；每次 ingest 对 `updatedIds ∪ insertedIds` 先 `deleteRefsFromSource(id, 'wikilink')` 再重建
  - 新文件 created 后查 `vault_unresolved_links` 中 `target_name` 匹配的行，重解析对应源块（软解析的「后到先解」）
- **验收**：测试——A 引用 `[[B]]` 而 B 尚不存在 → unresolved；创建 B → ref 出现、unresolved 清空；改名 B → 引用保留（已由 move 保证，加断言）；`[[B|别名]]` 正确
- **依赖**：无 · **估算**：2 人天
- **状态**：完成（`0a44cfe`）
  - 解析在块粒度：代码块整块跳过、行内代码等长打码后匹配；`![[embed]]` 不建 ref（V-303 渲染）
  - 目标解析按「最短唯一路径」：精确 rel_path（补 `.md`）→ 唯一 basename → basename 忽略大小写；多义与缺失都记 `vault_unresolved_links`
  - 带锚点的引用在 V-302 前一律记 unresolved（不建 ref），避免指错块
  - 引用目标 = 文档根 block id → 改名 / 移动天然保持；回收站删除时把「谁引用过这个名字」补记进 unresolved，同路径重现后由 `resolveUnresolvedForDoc` 自动补回
  - 测试：`vault.test.ts` 7 例（缺失→补建、别名与路径、多义、代码块与行内代码、改名保持、回收站重现补回、删除清理）

### V-302 `#heading` / `^block` 锚点

- **目标**：`[[Note#Heading]]` 指向 heading 块；`[[Note#^abc123]]` 指向带 Obsidian 块 id 的块
- **文件**：`vault/wikilinks.ts`、`packages/core/src/markdown/parseMdast.ts`（段落行尾 ` ^id` 剥离进 `properties.obsidian_block_id`）、`blocksToMarkdown`（序列化时还原 ` ^id`）
- **要点**：heading slug 比较用 Obsidian 规则（保留大小写与空格的模糊匹配：trim + 折叠空白 + 忽略大小写）；块 id 正则 `\^[A-Za-z0-9-]+$`；降级顺序见 RFC 0002 §引用解析
- **验收**：测试——三种锚点各一例；`^id` 经 ingest → 写回 往返字节不变（与 V-203 联动）
- **依赖**：V-301、V-304 · **估算**：1.5 人天

### V-303 vault 内图片直出

- **目标**：`![](assets/x.png)`、`![[x.png]]` 在 Web 阅读器和 MCP 里可见，不复制进 `data/media`
- **文件**：`vault/index.ts`（新路由 `GET /api/v1/vault/raw/*`）、`packages/web/src/components/**`（图片 src 解析）、`mcp/tools.ts`（`notefast_get_doc` 输出相对路径保留）
- **要点**
  - `raw/*`：`toVaultRelPath` 守卫 + 白名单扩展名（png/jpg/jpeg/gif/webp/svg/pdf）+ `Cache-Control: private, max-age=60` + ETag=sha；不服务 `.md`
  - 渲染层：vault 文档的相对图片路径按**所在文件目录**解析（`dirname(rel_path)` + 相对路径 → `/api/v1/vault/raw/<rel>`）；`![[x.png]]` 按 Obsidian 规则在全 vault 找 basename
  - 文档 API 需带出 `vault_path`（见 V-401）供前端解析
  - 不做：图片上传到 vault、`asset:` ↔ 路径双向映射（db notebook 的 `asset:` 语义不变）
- **验收**：测试——路由守卫（`../`、`.md`、未知扩展名 404/400）；ETag 命中 304；前端单测：相对路径解析
- **依赖**：V-401（`vault_path` 字段） · **估算**：2 人天

### V-304 解析器对 Obsidian 语法的无损识别

- **目标**：mdast 解析对 callout / `%%…%%` / `^id` / `![[embed]]` / 数学块 `$$` 不丢字、不合并、往返稳定
- **文件**：`packages/core/src/markdown/parseMdast.ts`、`packages/core/src/markdown.ts`、`packages/core/src/__tests__/**`
- **要点**：callout 保持为 blockquote 块并保留 `[!type]` 首行；`%%` 注释保持为段落原文（不渲染由 web 层处理）；`$$…$$` 作为独立块；`![[x]]` 保持为段落原文（V-303 渲染时处理）；每种语法加 `blocksToMarkdown(parse(x)) === normalize(x)` 往返测试
- **验收**：往返测试全绿；`vault.test.ts` 用 V-203 fixture 断言块数与顺序
- **依赖**：无 · **估算**：1.5 人天
- **状态**：完成（`5a634a9`）
  - **修掉一处数据丢失**：含列表 / 代码 / 表格 / 嵌套引用的 blockquote（Obsidian callout 的常见形态）此前只保留段落，其余子节点被静默丢弃 → 这类引用改为整段存原文（`properties.markdownFallback`），序列化直接回写
  - 空引用行序列化为 `>`（此前是 `> ` 带尾随空格），Obsidian 文件可逐字节往返
  - 逐字节往返已覆盖：callout（含折叠 / 列表 / 代码 / 表格 / 嵌套）、`%%` 注释（行内 / 整段 / 多行）、`^id`（段落 / 标题 / 列表项）、`![[embed]]`（整块 / 带尺寸 / 列表内）、dataview 围栏、行内 `$x$`
  - 唯一保留的归一化：独占行 `$$…$$` → ```math 围栏（设计如此，块仍是独立 code 块）；强调符号 `_x_` → `*x*` 仍在「被编辑块」上发生
  - 测试：`core/__tests__/obsidianRoundtrip.test.ts`（24 例）；`vault.test.ts` 增加 fixture 块数 / 顺序 / 属性断言与「含列表 callout 改相邻块」保真用例

---

## M4 体验

### V-401 API / MCP 暴露 vault 信息

- **目标**：AI 与前端知道一篇文档来自哪个文件
- **文件**：`api/docs.ts`（`GET /docs/:id` 响应加 `vault_path`）、`mcp/tools.ts`（`notefast_vault_status`、`notefast_vault_rebuild`、`notefast_get_doc` 加 `vault_path`、`notefast_create_doc` 可选 `path` 参数指定落盘子目录）、`vault/writeback.ts`（新建文档尊重 `properties.vault_hint_path`）
- **要点**：`/api/v1` 只做加法；`path` 参数走 `toVaultRelPath` 守卫；工具描述用中文
- **验收**：mcpTools 测试覆盖两个新工具与 `path` 参数；`GET /docs/:id` 在 db notebook 下无 `vault_path` 字段
- **依赖**：M2 · **估算**：1 人天
- **状态**：完成（`36317e8`）
  - `GET /docs/:id` 与 MCP `notefast_get_doc` 在 vault 文档上带 `vault_path`（相对 vault 根）；判定走 `notebooks.kind`，db notebook 不出现该字段
  - MCP 新增工具组 `mcp/tools/vault.ts`：`notefast_vault_status`（只读；未启用返回 `enabled:false` + hint）、`notefast_vault_rebuild`（写工具，走 scope 门禁；未启用报 `invalid_params`）
  - `notefast_create_doc` 新增可选 `path`：走 `toVaultRelPath` 守卫（越界 → `invalid_params`），存进文档根 `properties.vault_hint_path`；未启用 vault 时传 `path` 直接报错
  - 写回落盘尊重 `vault_hint_path`：以 `.md` 结尾视为完整文件名（重名追加 ` (n)`），否则视为子目录；越界提示回退 vault 根
  - 运行时通过 `vault/index.ts` 的 `getActiveVaultRuntime()` 暴露（不改 `registerMcpTools` 签名；`start()` 挂上、`stop()` 清空）
  - 测试：`mcpVault.test.ts`（5 例，真实 MCP 会话）、`vault.test.ts`（`GET /docs/:id` 字段有无、`vault_hint_path` 落盘 / 去重 / 越界）

### V-402 Web：设置页 vault 面板 + 文档头来源

- **目标**：用户能看到 vault 状态、触发对账、看到冲突；文档页显示文件路径
- **文件**：`packages/web/src/routes/settings/Vault.tsx`（新）、`settings/index.tsx`、`routes/doc.tsx`（头部路径 + 复制路径）、`i18n/zh-CN/settings.json` 与 `en/settings.json`（同 key 同行号）
- **要点**：只在 `/api/v1/vault/status.enabled` 时显示入口；样式走 tokens，禁止 `dark:` 与任意字号；`Button` / `Input` 组件；对账进行中禁用按钮并轮询 `reconciling`
- **验收**：`bun lint` i18n 对齐通过；组件测试：disabled 状态、冲突列表渲染
- **依赖**：V-401、V-204 · **估算**：2 人天

### V-403 桌面壳「打开文件夹为 vault」

- **目标**：macOS / Windows 壳选择文件夹即以 vault 模式启动引擎
- **文件**：`clients/apple/**`、`clients/tauri/**`、`packages/server/src/native/bootstrap.ts`
- **要点**：壳传 `VAULT_PATH`；`DATA_DIR` 按 `sha256(vault_path)` 前 12 位落在应用支持目录（一个 vault 一个索引，RFC 0001 D4）；最近 vault 列表存壳侧；引擎不改业务
- **验收**：`nativeBootstrap.test.ts` 增加 env 透传断言；手工验证两平台
- **依赖**：V-401 · **估算**：2 人天

### V-404 定时轻量对账 + 自愈

- **目标**：chokidar 漏事件 / 休眠唤醒后索引自动追平
- **文件**：`vault/index.ts`、`vault/ingest.ts`（`reconcileVault({ light: true })`）
- **要点**：每 `VAULT_RECONCILE_MINUTES`（默认 10）跑一次 light 模式——只 `stat` 比较 `size + mtime_ms` 与映射行，不同才读文件；`process.on('SIGCONT')` / 前端可见性变化不做，靠定时；`status` 暴露 `next_reconcile_at`
- **验收**：测试——绕过 watcher 直接改文件 → 触发 light 对账 → 入库；未变文件不读（用计数 spy）
- **依赖**：无 · **估算**：1 人天

---

## M5 发布

### V-501 性能验证

- **目标**：1000 文件首次对账 < 30s，10k < 5min，内存峰值可接受；单文件变更 → 可搜 < `stabilityMs + 200ms`
- **文件**：`packages/server/src/eval/vaultBench.ts`（新，生成合成 vault 并计时；不进产品）
- **要点**：对账期间 `pauseShadowWrites`、hooks 批量化（`fireAfterCreateMany` 已有）；发现热点再优化，不预先优化
- **验收**：bench 脚本输出写进 RFC 0002 §验证标准表；若不达标开 issue 列热点
- **依赖**：M2 · **估算**：1 人天

### V-502 迁移指引定稿

- **目标**：`docs/vault-migration.md` 从草稿变为可执行步骤（RFC 0001 D7）
- **要点**：实际走一遍「v0.86 实例 → `GET /api/v1/export/archive` → 整理文件夹（去 `--<id>` 后缀、`media/` → `assets/`）→ 新 DATA_DIR + VAULT_PATH」；记录丢失项与耗时；README 加一节
- **依赖**：V-303（图片路径）、V-501 · **估算**：0.5 人天

### V-503 Docker

- **目标**：bind mount 下监听可用
- **要点**：`VAULT_USE_POLLING` / `VAULT_POLL_INTERVAL_MS` 已落地（`vault/config.ts`，status 暴露 `use_polling`）；剩余：`docker-compose.yml` 注释示例 + `/vault` 挂载约定；`Dockerfile` 确认 chokidar 进镜像；文档说明 macOS Docker Desktop 必须 polling
- **验收**：手工 compose 验证（改文件 → `GET /vault/status.files` 变化）
- **依赖**：无 · **估算**：0.5 人天

### V-504 首个可用版本

- **目标**：`next` → `main` `--ff-only`，release-please 出版本
- **要点**：门禁 = M2 全绿 + V-501 达标 + V-502 完成；CHANGELOG 由 conventional commits 生成；`bump-minor-pre-major` 下 `feat!` 只升 minor
- **依赖**：以上全部

---

## 完成定义（每个任务）

- 对应测试新增并通过；`bun lint && bun run typecheck && bun test` 全绿
- 行为变更同步更新 RFC（决策）与本文件（状态列）
- commit 遵循 Conventional Commits，scope 用 `vault`（如 `feat(vault): patch write-back by block span`）
- 没有在仓库留下临时文件 / fixture 目录；`/tmp` 自行清理
- 不顺手重构无关代码；发现的问题记到本文件末尾「待议」

## 待议

（执行中发现但未决的问题记在这里，附发现者与日期）

- ~~2026-09-09（V-201 评估）：**V-203 列表保真缺口**——按「顶层块 span」整体替换列表时，未改动的兄弟列表项也会被 `blocksToMarkdown` 归一化~~ → V-203 落地后每个顶层列表项是独立块（嵌套项是它的子块），兄弟项不再被波及；剩余问题是**序列化器拍平嵌套项**（语料 `21-nested-list` 冻结），导致整篇退回后无法重建区间 → 这类文档持续走整篇写回。修序列化器属于 V-304 范围。
- ~~2026-09-09（V-201 评估）：**V-203 span 偏移必须与 `stripTitleHeading` 组合**~~ → 已解：区间按块记录（含被提升的 H1 子块），`stripTitleHeading` 只影响哪些块是顶层，不改变区间偏移。
- 2026-09-09（V-202 落地）：**文件改 status 不复制 API 的级联**——`PATCH /docs/:id/status` 在归档时会撤销公开分享、升格时 `reanalyzeDoc`；ingest 里只做 `updateBlock({ status })` + `fireDocAfterStatusChange`。若认为文件也是「用户操作」，应把这段抽成共享函数（`services/docStatusChange.ts`）给两处复用。
- 2026-09-09（V-202 落地）：**frontmatter 识别是启发式**——「所有非空行都像 YAML」才算 frontmatter；单行 `Note: 正文` 这类仍是误判面。若 Obsidian 侧出现误剥离，考虑改为「首行必须是 `key:` 或 `key: value`」再放宽。
