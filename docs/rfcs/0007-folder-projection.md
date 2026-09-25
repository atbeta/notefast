# RFC 0007: 文件夹投影 — 保留 db 权威，把「文件夹」做成双向接口

- 状态：草案（待确认）
- 日期：2026-09-26
- 依赖：无（可直接在 `main` 上落地）
- 相关：RFC 0001–0006（`next` 分支的 vault 方案，本 RFC 是其替代路线）、`docs/plans/vault-mode.md`、`AGENTS.md`
- 前置阅读：RFC 0001 §动机、RFC 0003 §回声抑制与§按块局部写回、RFC 0006 §唯一形态

## 摘要

`next` 分支用「文件是权威、SQLite 是派生索引」的 vault 模式解决「用户要拥有真 `.md` 文件」的诉求（RFC 0001）。这条路线在实现上是高质量的，但它把「文件夹」从**一个接口**升级成了**第二个权威**，代价是四层状态各自漂移（正文 / 索引 / frontmatter 元数据 / 文件系统事实），并连带砍掉 db 模式已有的四项功能（影子副本、资源页、图床、归档导出）。

本 RFC 提出替代路线：**保留 SQLite 作为唯一权威**，把现有只读的影子副本（`services/shadowMarkdown.ts`）升级为**双向感知的文件夹投影**。

- **出方向**：SQLite → 文件。文档变更时，按块局部写回（不是整篇重排），未改动字节原样保留。
- **入方向**：文件 → SQLite。外部编辑经 watcher 导入。
- **冲突**：SQLite 赢，外部版本落同目录 `<stem>.notefast-conflict-<时间戳>.md`。
- **路径归用户**：首次投影取默认名，之后**以磁盘实际路径为准**（`doc_id ↔ rel_path` 映射），用户可自由改名 / 移动 / 整理目录。

因为每个方向的权威都是**单向**的（出方向是投影，入方向是导入），vault 方案里为「双向对等」而生的复杂度自然不成立：不需要回声抑制、不需要 `meta_hash`、不需要用 frontmatter 承载元数据、不需要 `.trash/` 语义。而 vault 已经实现的核心机制——**按块局部写回、原子写、冲突副本、watcher 探测**——可以整体复用。

## 问题：vault 路线为什么「感觉会乱」

用户 2026-09-26 的原话是「尝试过，但感觉会乱，没有找到一种优雅的方式」。这个直觉有结构性来源，不是实现缺陷。

vault 同时维持四个会各自漂移的状态，而 RFC 只承认前两个：

| 状态 | 载体 | 谁写 | 漂移时谁赢 |
|---|---|---|---|
| 正文 | `.md` 文件 | 用户 / 外部工具 / 写回 | 文件 |
| 索引 | SQLite `blocks` / FTS / vec | ingest | 文件（可重建） |
| **NoteFast 元数据** | **frontmatter 三键** | **两边都写** | 未定义 |
| **文件系统事实** | `rel_path` / `.trash/` / `<笔记>.assets/` | 用户 / 写回 | 未定义 |

后两层的补丁痕迹在 RFC 里可见：

- `archived` **无法在文件里表达**（RFC 0001 D8），缺键时「不降级」——归档状态实际仍是活在索引里的第二权威，只是被小心藏起。
- `content_sha256` 一列承担**四个职责**（变更短路 / rename 配对 / 重现恢复 / 写回并发），RFC 0002 自称「整个设计里最重要的字段」。一个字段四种语义是耦合。
- `doc_updated_at` + `meta_hash` 两个字段专门识别「这是我自己的回声」。**回声检测的存在本身就证明有两个作者在写同一个东西。**

RFC 0005 列出的四类混乱（模式不可见 / 部署分叉 / 切换 = 换库 / parity 缺口）都是这个根本问题的症状。P1–P5 的统一路线在治疗症状。

## 决策记录

### D1 SQLite 是唯一权威，文件夹是它的双向接口

不引入 `kind='vault'`。`notebooks` 表不变，`blocks` 表不变。新增的只是「一个 notebook 可以绑定一个投影文件夹」。

**用户心智**：你的笔记是 NoteFast 库里的文档，同时它们以 `.md` 文件的形式镜像在一个文件夹里，你可以直接编辑那些文件。

**与 vault 的根本差别**：vault 说「文件是权威，索引跟随」；本方案说「库是权威，文件夹是它的可达表示」。两者都让用户拿到真文件，但对「同时改时谁赢」的回答不同。

### D2 路径归用户，不由投影决定

现有影子副本的路径是 `archiveRelPath(title, docId, tags)` = `<首标签|untagged>/<slug>--<id12>.md`（`sync/archive.ts:57`）。这套命名是为**归档导出**设计的（一次性输出，id 后缀保证不重名），**不适合长期驻留的文件夹**：用户看到 `我的笔记--a1b2c3d4e5f6.md` 会立刻反感。

投影模式下的规则：

1. **首次投影**：默认 `<slug>.md`，落在文件夹根（或用户配置的目录模板）。**不带 id 后缀**；重名时追加 ` (n)`（沿用 RFC 0003 创建路径的既有规则）。
2. **此后以磁盘为准**：`doc_id ↔ rel_path` 映射一旦建立，重命名 / 移动文件**不改写映射的语义**，只更新 `rel_path`。用户在 Finder 里把 `foo.md` 改成 `bar.md`，下次投影仍写 `bar.md`。
3. **外来的 `.md`**（没有映射行的）：当作新文档导入，路径就是它现在的路径。

这条让「文件夹是用户的」成立——用户可以整理目录结构，投影会跟随而不是对抗。

### D3 元数据留在 SQLite，不写进 frontmatter

**与 RFC 0001 D8 相反**。投影模式下 `tags` / `ai_exclude` / `status` 的权威在 SQLite：

- 出方向：**可选**把 `tags` 写进 frontmatter（供人阅读 / Obsidian 识别），但这是**只读投影**，外部改它不会回写。
- 入方向：**不读** frontmatter 里的 `notefast_*` 键。忽略。
- 因此不需要 `archived` 的例外（D8 的补丁），不需要 `meta_hash`，不需要 frontmatter 行级透传。

代价：用户在 Obsidian 里改 `tags:` 不会同步到 NoteFast。**这是有意的**：vault 方案为了让这条成立，付出了 frontmatter 三键双向 + `meta_hash` + 回声盲区修补的全部复杂度。本方案承认这条做不到，换取整体简化。

**用户手写的其他 frontmatter 字段**（`aliases`、`cssclasses`、自定义键）仍必须**逐字节保留**——这是 D4 局部写回的直接推论，也是现有 `patchFrontmatter` 已经实现的能力。

### D4 出方向用按块局部写回，不整篇序列化

**这是整个方案的技术核心，也是从 vault 线整体复用的部分。**

现有影子副本用 `portableDocMarkdown` → `blocksToMarkdown(tree)`，每次都整篇重新序列化。在只读投影下这没问题（用户不编辑那些文件）；一旦文件变成**用户可以编辑的**，整篇序列化就会每次重排用户排版——不可接受。

vault 线的 `vault/patch.ts`（119 行）+ `vault/spans.ts`（86 行）解决了这个问题，且**几乎零 vault 耦合**：

- `patch.ts` 只 import 两样东西：`patchFrontmatter / stripDocFrontmatter`（来自 `@notefast/core`）和 spans 的行类型（来自 `store/vaultSpans`）。它是**纯文本区间手术**，不知道 vault 的存在。
- 机制：以 `vault_block_spans` 记录每个顶层块的 `[start, end)` 行区间 + 子树指纹；指纹未变的块**直接复制磁盘旧字节**，只有被编辑的块重新序列化；相邻未变块之间的空行照搬。

这套机制在投影模式下的语义完全成立——**它本来就是「只在必要时改写文件」的机制，与谁权威无关**。

### D5 冲突时 SQLite 赢，外部版本落副本

沿用 RFC 0003 的策略，但**裁决方向相反**：

- **vault**：文件是权威，SQLite 端的编辑冲突时让位（`VaultConflictError` → 另存 NoteFast 版本为副本）。
- **本方案**：SQLite 是权威，外部编辑冲突时让位（外部版本另存为副本），库里的版本继续写下去。

统一的机制：冲突时**绝不静默覆盖任何一方**，落 `<stem>.notefast-conflict-<yyyyMMdd-HHmmss>.md`，记审计事件，在 `/api/v1/vault/status.conflicts` 等价端点暴露计数。

**用户已确认接受这个方向**（2026-09-26：「我同意低的 NoteFast 赢」——低 = 底层 = SQLite 权威）。

### D6 入方向的定位：导入 + 持续跟进，不是「重建索引」

外部改动经 watcher 导入：

- 文件是新的（无映射）→ 建文档（**沿用现有 `POST /import/markdown` 的语义**）
- 文件有映射且内容变了 → 更新对应文档的块（沿用 `syncMarkdownChildren`，保块 id 稳定，与编辑器整篇保存同一函数）
- 文件消失了 → **文档进回收站**（D9）

**与 vault ingest 的关键差别**：vault 的 ingest 是「索引跟随文件，文件消失 = 索引行打 `deleted_at`」；本方案的导入是「库吸收文件的变更」，库的删除/回收站语义不受文件系统影响。

### D9 删除双向同步，恢复靠库的软删除（已确认）

**用户确认**（2026-09-26）：「删除文件……确实应该同步删除，如果可能尽可能提供优雅的恢复机制」。

删除在两个方向都成立：

| 方向 | 触发 | 行为 |
|---|---|---|
| 库 → 文件 | 库内删除文档 | 删除投影文件 |
| 文件 → 库 | 用户删掉 `.md` | 文档进**回收站**（软删除），不是永久删除 |
| 恢复 | 用户在回收站点恢复 | 文档回到流通，**投影文件在下次出方向时重建** |

**恢复机制为什么能「优雅」——已核实**：库的软删除保留完整数据，恢复路径是现成的：

- 软删除只打 `is_deleted = 1` + `delete_id` tombstone（`store/blocks.ts:8`），**块内容仍在库里**
- 恢复端点 `POST /blocks/:id/restore`（`api/blocks.ts:290`）已经在做正确的事：恢复整棵子树、对文档根补 `scheduleDocIndex` + `reanalyzeDoc`（向量和 AutoLink 重建）、`scheduleSyncNow`
- 注释明确：「删除时向量被清、mentions 被物理 purge，恢复时补全重索引 + autoLink 重抽」

**所以「删文件 → 进回收站 → 恢复」这条链在 `main` 上已经通了**，投影只需接上：文件消失时调软删除而不是直接 purge。用户在回收站恢复后，出方向会把文件重新写出来。

一处**必须注意**：`softDeleteBlocks` 会清向量、purge mentions，恢复时靠 `reanalyzeDoc` 重建——**这需要 AI provider**。零模型配置下 `reanalyzeDoc` 是安全 no-op，所以恢复后文档正文完整、但语义检索要等到配置 provider 后重建。这是可接受的降级（AGENTS.md：零模型配置须优雅降级），但文档里要写明。

**不做**：文件系统的回收站（`.trash/` 目录）。删除就是真删文件；「后悔药」由库的回收站提供。理由：两个回收站（库的 + 文件夹的）会让用户不知道去哪找，而库的回收站已经有完整实现。

### D10 附件：单一实现，跟随投影文件夹（已确认）

**用户授权由本 RFC 决定**（2026-09-26）：「附件是不是提供几种模式也是你来帮我定吧（前期可以用最科学的单一实现）」。

**决定：投影文件夹里的笔记，图片落在同目录的 `<笔记名>.assets/`，正文写相对路径。**

理由（按权重排序）：

1. **这是唯一能让文件夹「自包含」的方案。** 投影的全部承诺是「这是一个你可以拷走、git 跟踪、用 Obsidian 打开的文件夹」。如果图片留在 `data/media/` 而正文写 `asset:<sha>`，拷走文件夹就是一堆碎图——**投影就白做了**。
2. **和 vault 线（U-13）结论一致**，可直接复用 `vault/images.ts`（102 行）。两条路线在这里不需要分歧。
3. **相对路径在任何 Markdown 工具里都能渲染**（Obsidian / VSCode / Typora / GitHub），`asset:<sha>` 只有 NoteFast 认识。
4. 每篇一个资源夹而不是共享 `assets/`：删笔记连资源夹一起删，归属清楚；也避免全库图片挤在一个目录。

**具体的双轨制**（保持 db 模式不受影响）：

| 场景 | 图片落点 | 正文引用 |
|---|---|---|
| 文档**有**投影映射 | `<笔记名>.assets/<文件名>` | 相对路径 `a.assets/截图.png` |
| 文档**无**投影映射（纯库文档） | `data/media/<sha256>` | `asset:<sha256>` |

判定依据是「这篇文档在投影文件夹里有没有文件」，而不是全局开关——同一实例里两种文档可以并存。

**现有代码已有这个形状**，不需要新抽象：`POST /api/v1/assets` 已经按「带不带 `doc_id`」分流（RFC 0006 U-13 记录），`ingestLocalImageRefs`（`assets/store.ts:530`）已经在做「相对路径 → 内容寻址 + 重写引用」的反向操作。投影模式下反过来复用同一套解析。

**不做**（前期）：
- 用户可配置的附件目录模板（`{filename}.assets` / `./images/` / 共享 `assets/`）
- 远端图床（db 模式的图床设置保留，投影文档不走它）

这两条都留作后续可选项，等有明确需求再加。**理由**：附件策略一旦可配置，就必须处理「用户改了配置之后已存在的图片怎么办」——这是个迁移问题，不值得在前期引入。

**一处连带决策**（沿用 vault U-13 的结论）：应用内改名文档时，`<笔记名>.assets/` 一起改名并改写正文相对引用；**应用外改名不动**（用户自己改的，不猜）。这条与 D2「路径归用户」一致——但注意这里有个**规则冲突需要解决**：D2 说用户可以在 Finder 里自由改名，而这条说不跟随资源夹改名。**裁决**：应用外改名时，投影**不主动**改资源夹，但如果正文的相对引用因此断了，下次导入时 `ingestLocalImageRefs` 会把它标为 unresolved（不静默改写成错误路径）。

### D7 投影是可选能力，默认关闭

与现有影子副本**默认开启**（`emptyShadowConfig()` 返回 `enabled: true`）不同，投影**默认关闭**，因为它需要用户指定一个文件夹并接受双向行为。

两者关系：**影子副本是投影的退化形态**（只写出方向、路径系统决定）。建议**合并为同一个功能的两种档位**，而不是两个并行模块：

| 档位 | 出方向 | 入方向 | 路径 | 用途 |
|---|---|---|---|---|
| `readonly`（现影子副本） | ✅ 整篇 | ❌ | 系统决定 | 「我想在访达里看见文件」 |
| `two-way`（本 RFC） | ✅ 局部 | ✅ | 用户决定 | 「我想用 Obsidian 编辑」 |

### D8 明确不做

- 不做 `kind='vault'`，不引入第二权威
- 不用 frontmatter 承载 NoteFast 元数据（D3）
- 不做同步文件夹冲突的自动合并（一律副本）
- 不做「一个 `.md` 按 H1 切多篇」
- 不要求投影文件夹进 git（那是用户的选择，应用不做假设）
- **不砍现有任何功能**（资源页、图床、修订历史、协议同步全部保留）

## 复用清单（从 `next` 线搬什么）

这是本方案相对 vault 的最大优势：核心机制已实现且可整体搬运。

**逐模块的完整判定见 `.ai/projection/reuse-analysis.md`（28k，含行号与代码引用）。** 下面是结论摘要。

### 前置约束：span 机制不在 `main` 上

**这是排序约束，不是模块问题。** 已核实（`git grep` 两个分支）：

- `parseMarkdownToBlocksWithSpans` —— 只在 `next`（`packages/core/src/markdown.ts`、`markdown/parseMdast.ts`）
- `patchFrontmatter` —— 只在 `next`（`packages/core/src/frontmatter.ts:321`）
- 相关测试 `parseMdastSpans.test.ts`、`obsidianRoundtrip.test.ts` 同样只在 `next`

`main` 的 `parseMdast.ts` 只有 `parseMarkdownToBlocksMdast`，不返回区间。

**推论：D4 的「只改被编辑的块」在把这两个 core 原语搬过来之前根本无法落地。** core 的改动量很小（frontmatter.ts 约 172 行 + 2 个测试文件），搬运成本低，但**必须先做**。

### 直接复用（零改动）

| 模块 | 行数 | 为什么能直接用 |
|---|---|---|
| `vault/patch.ts` | 119 | 纯函数，只 import core frontmatter + spans 行类型；**不知道谁权威**，且它唯一的调用方（`writeback.ts:285-291`）本来就是 db→file 方向 |
| `vault/watchProbe.ts` | 195 | 探测文件系统事件投递能力，与权威方向无关 |
| `store/vaultSpans.ts` | 51 | 纯 CRUD；`content_hash` 正是「这个块变了吗」的判据 |
| `vault/lock.ts` | 15 | 串行锁，零 import |
| `vault/audit.ts` | 17 | 可用，但**头注释需改**——它写着「多端同步由文件层负责」，投影下不成立 |
| 迁移 025 | 31 | 块区间表，本方案的核心表 |

`patch.ts` 的一个细节值得记下：**frontmatter 补丁为空时用户 YAML 逐字节不变**（`frontmatter.ts:321-358`：raw 非空且无键 → 原样返回；raw 为空且无键 → 返回空串）。所以 D3「元数据不再权威」在 `patch.ts` 里**改动量为零**。

### 复用但需改造

| 模块 | 行数 | 改造点 |
|---|---|---|
| `vault/writer.ts` | 87 | 保留 tmp+rename（71-86）与未变短路（67-69）；`expectedSha` 乐观校验**可原样保留**——`writeback.ts:302-313` 已经在捕获 `VaultConflictError` 并转 `conflictWithCopy`，那正是 D5 要的行为。**只需改调用方的态度**：从「拒绝覆盖」改为「记审计 + 落副本 + 继续写」 |
| `vault/spans.ts` | 86 | `blockSubtreeHash` / `topLevelBlocks` 是纯函数。`recordVaultSpans` 的结构一致性自检**要保留**（它守住 patch 安全），只改**调用时机**：出方向写完之后，而不是 ingest 结束时 |
| `vault/writeback.ts` | 451 | 约 200 行可用：`uniqueRelPathForTitle`（101-139，首次投影的命名器）、`conflictStamp` + `writeConflictCopy`（161-193）、`patchBlocksOf`（86-93）。删回声判定（236-241）、`.trash` / `restoreTrashed`（349-399）、`trashDoc`（401-418） |
| `vault/ingest.ts` | 626 | **只约 35–40% 存活**。死代码：`DocState`/回收站态（114-126）、`applyFileMetaToDoc`（128-165，38 行）、`removeVaultFile`（358-418，61 行）、sha 短路与 rename 配对状态机（196-228，约 29 行）、fmTags/fmAiExclude/fmStatus（232-235）。存活：解析与对齐（`stripDocFrontmatter` → `parseMarkdownToBlocksForSave` → `syncMarkdownChildren`，288-312） |
| `vault/watcher.ts` | 201 | 约 120 行可用。删 rename 配对（`holdUnlink`+`tryPairRename` 69-91、unlink-flush 100-112）；保留队列合并（55-67）、串行 drain + 锁（116-127）、chokidar 装配（175-191）。**但要新增一个投影特有场景**：我们自己的出方向写（tmp+rename）在某些平台会产生 unlink+add，需要 sha 回声检查，且必须跑在 drain/解析**之前** |
| `vault/paths.ts` | 69 | `toVaultRelPath` 的越界守卫可用；`isIgnoredRelPath` 的「任何以 `.` 开头的段都忽略」对用户自选文件夹**过于激进**，但必须仍能识别 `.notefast-conflict-*` |
| `vault/wikilinks.ts` | 302 | 约 150 行：`parseWikilinks` / `resolveWikilinkDoc` / `resolveAnchorBlock` 是纯解析，与权威无关。`VaultFileIndex`（63-130）假设 rel_path **就是**文件身份——投影下它只是个可改的标签 |
| `vault/inspect.ts` | 117 | 约 45 行：`CONFLICT_INFIX`（16）+ `listVaultConflicts`（30-57）与 D5 的副本命名一一对应；`listVaultTrash`（71-117）无用 |
| `store/vaultFiles.ts` | 191 | 约 130 行：**这张表就是本方案要的 `doc_id ↔ rel_path` 映射**。去掉 `meta_hash`、`frontmatter_raw`；`deleted_at` 改语义 |
| `vault/config.ts` | 70 | env → 用户配置；`writeback` 布尔改为「双向是否开启」 |
| `vault/images.ts` | 102 | 取决于开放问题 3：采用 `<笔记名>.assets/` 则可用，保持 `asset:<sha>` + `data/media/` 则为 0 |
| `vault/meta.ts` | 60 | 约 15 行存活；`readVaultDocMeta`/`vaultMetaHash`（20-37）专为回声检测而存在，`desiredStatusFromFile`（45-51）被 D3 直接废止 |
| `vault/captureConfig.ts` | 76 | 可选；「新建文档的默认子目录」与权威方向无关 |
| 迁移 023 | 47 | **需要一个变体**（约 25 行）：保留 `vault_files`，去掉 `deleted_at` 的回收站语义；**删掉** `notebooks.kind` / `vault_root`（投影不改 notebook 类型） |

### 不需要（vault 特有）

| 东西 | 行数 | 原因 |
|---|---|---|
| `vault/meta.ts` 的回声部分 | — | 元数据不进文件（D3） |
| 迁移 024 | 29 | `frontmatter_raw`（写回透传）+ `meta_hash`（回声修补）都是 vault 专有 |
| 迁移 026 + `store/vaultLinks.ts` | 31 + 160 | 未解析 wikilink 的软解析，vault 特性 |
| 迁移 027 + `store/vaultSyncState.ts` | 27 + 68 | 只服务 fileSync |
| `vault/tree.ts` | 128 | 从 `vault_files` 建文件夹树 UI；`main` 已按 tag 组织，不需要第二棵树 |
| `vault/dataDir.ts` | 171 | 解决「每个 vault 的索引放哪」；投影保持 SQLite 权威与 `data/` 布局 |
| `vault/fileSync*.ts` | 451+302+60 | RFC 0004 的多端 blob/manifest/LWW 引擎，独立特性（其 `writeFileAtomic` 与 `conflictCopyRelPath` 可作参考） |
| `.trash/` 语义 | — | 删除语义归库（D6） |

**净结论：约 1100–1300 行可搬，集中在机制层。`next` 的真正价值不是 vault 语义，而是它为了 vault 被迫造出来的 patch / span / 指纹 / 原子写 / watcher 探测机制——这些机制与权威方向无关。**

### 需要新建的接口（`next` 上不存在）

1. **块级变更信号。** `DocChangeEvent`（`services/docEvents.ts:18-22`）只有 `{doc_id, kind, at}`，**没有块 id**。所以「只 patch 被改的块」今天没有触发源——现在的做法是重新指纹**所有**顶层块，靠 `reuse` 跳过字节复制，输出正确但每次编辑是 O(文档)。建议加可选的 `changed_block_ids?: string[]`。**`main` 现有的 `shadowMarkdown` 有同样的限制**（236-248 每次整篇重序列化）。
2. **「文件被删 → 文档怎么办」的策略决定**（见开放问题 2）。
3. **路径命名策略。** `uniqueRelPathForTitle`（39 行）可直接用作首次投影的命名器。注意 `main` 现有 `archiveRelPath` 的 `<id12>` 后缀**存在的理由就是「从路径反查文档」**——有了映射表它就不必要了，因此文件名可以更干净（这正是 D2 的依据）。

## 连带简化（本方案附带的收益）

用户明确要求「基于这个方案如果还有连带着的其他地方可以简化的，可以一并简化」。以下是调查中发现的**已经存在冗余**，与投影方案天然相关：

### S1 三条「导出 Markdown」路径应当收敛

现在并存三条，且**共用同一个命名函数** `archiveRelPath(title, docId, tags)`：

| 路径 | 位置 | 触发 |
|---|---|---|
| 影子副本 | `data/markdown/`（`services/shadowMarkdown.ts:237`） | 每次文档变更 + 启动全量 |
| 自动导出 / 归档 | `AUTO_EXPORT_DIR`（`services/autoExport.ts:68`） | 定时 1h 兜底 |
| 同步 adapter 归档 | LocalFS / S3 / WebDAV（`sync/archivePush.ts:73`） | 同步周期 |

`autoExport.ts` 的头注释自己承认已被 sync adapter 接管，只剩 `AUTO_EXPORT_DIR` 兜底：

> 老 startAutoExport 的行为：…… 否则保留一个兜底的 setInterval …… 真正的"按 interval 同步"逻辑由 sync/manager.ts 的 autoSyncTimer 负责

**建议**：影子副本升级为投影后，`AUTO_EXPORT_DIR` 兜底与投影功能重叠（都是「把库导出成文件夹」）。可以收敛为**「投影」+「远端归档」两条**，删掉 `AUTO_EXPORT_DIR` 这条中间态。`sync/archivePush.ts` 与投影共用 `portableDocMarkdown` / `patchFrontmatter`，不冲突。

### S2 路径命名函数应拆分

`archiveRelPath` 现在同时服务「一次性归档」（需要 id 后缀防重名）与「影子副本」（不需要但被迫接受）。投影需要的是「用户友好且稳定」的命名（D2）。**建议拆成两个函数**，各自服务明确场景，而不是让一处妥协另一处。

### S3 `/api/v1/vault/*` 端点不必新建一套

`next` 线加了 14 个 vault 路由。投影模式下多数不需要（tree / trash / conflicts 的文件系统版本），但**状态与冲突查询需要**。建议复用 `/api/v1/instance` 扩展一个 `projection` 字段（模式、文件夹、是否双向、watcher 模式、最近冲突），而不是开一个新命名空间。

理由：AGENTS.md 的「`/api/v1` 只做加法」——新增字段是加法，新增命名空间会让契约面永久变大。

### S4 「多端同步」的两套实现问题（长期）

RFC 0004 自己写的规律是「**要么同步文件，要么同步变更仓库，不能两者都同步**」。vault 路线的代价是两套并存（协议同步 2222 行 + 文件同步 451 行，靠 `kind` 分流）。**投影方案下这个矛盾不存在**：`sync/` 协议同步继续管 SQLite，投影文件夹交给用户自己的 git / iCloud——**天然只有一套**。

这是选择投影而非 vault 的**主要结构性收益**。

### S5 「归档 vs 同步 vs 备份」三轨的表述可以简化

`AGENTS.md` 现有：「备份与归档分轨：灾备 = 应用内 SQLite→S3 快照，Markdown 归档（LocalFS/S3/WebDAV）是单向便携副本」。

引入投影后变成两轨更清晰：**灾备 = SQLite 快照**（不变），**便携 = 文件夹投影**（本地或远端）。归档导出（zip）与 `AUTO_EXPORT_DIR` 都可以归入「投影的一次性快照形态」，而不是独立能力。

## 用户可感知的取舍（必须写进文档）

**本方案与 vault 的唯一实质差别**：

> 当同一个文档**同时**被 NoteFast 和外部工具修改时，**NoteFast 的版本赢**，外部改动落为冲突副本。

- **vault**：文件永远赢。Obsidian 用户有绝对安全感。
- **投影**：库赢。用户会看到「我在 Obsidian 里改的怎么变成副本了」。

对「一次只在一个地方编辑」的绝大多数用法，两者无差别。差别只在并发编辑时。

**因此适用范围**：NoteFast 是主编辑器、文件夹是外挂（本方案）；vs 文件夹是主战场、NoteFast 是访客（vault）。

这个取舍必须在首次开启投影时**明确告知用户**，并提供一条出路：如果用户主要用外部工具编辑，建议他改用「只读投影 + 定时导入」而不是双向。

## 实施记录

### P1a 完成（`2cc2e5f`）

core 原语已搬到 `main`：`parseMarkdownToBlocksWithSpans`（含 `bodyOnly`）、`patchFrontmatter`、`blocksToMarkdown` 的 Obsidian 往返。三个测试文件同步搬入。core 测试 304 → 347。

### P1b 完成（`4bff899` 机制层、`df1f84a` 接线）

- `projection/{patch,spans,writer,lock}.ts` + 迁移 **023**（编号取 main 的下一个空位，非 next 的 025）+ `store/projectionSpans.ts`，全部去掉 vault 命名与语义。
- 出方向已接进 `services/shadowMarkdown.ts`：能局部改写就局部改写，否则整篇序列化；两条路径都刷新区间记录。

**接线中发现并修正的两个真实回归**（都是「首次跑通测试」之后才暴露的）：

1. **标题行被丢掉**。投影文件里有 `# 标题`，但库里标题是**文档根而不是块**。这导致两个后果：① 区间对齐必然失败（解析出 4 个顶层块 vs 库里 3 个），区间表**永远是空的，局部改写从不生效**——第一版实现就是这样，且测试全绿；② 修正对齐后第二次写回把 `# 标题` 丢了。修法：区间相对「剥 frontmatter + 剥标题行」之后的正文，写回时把标题行原样拼回。
2. **`tags: []` 被删掉**。`patchFrontmatter` 把空数组视为「删除该键」，而整篇路径写的是 `tags: []`，于是两条路径产出不同内容，「内容未变时 fullSync 不重写文件」的既有保证退化。修法：tags 为空时不动 frontmatter。

**一个必须写下来的既有事实**：**首次投影本身就是有损的**——`_斜体_` → `*斜体*`、嵌套列表被拍平、连续空行被压成一个。这是既有序列化行为，不是本次引入。因此 P1b 的契约是「首次之后逐字节保留」，测试里专门有一条用例**钉住**这个有损性，避免后续用例建立在不存在的假设上。

### 测试方法论（值得沿用）

P1b 的三次变异测试中有**两次最初没被捕获**：

| 变异 | 首次结果 | 原因 |
|---|---|---|
| 破坏字节复用（直接用 DB 文本）| ❌ 未捕获 | fixture 里 DB 文本与磁盘字节恰好相同 |
| 关闭局部改写路径 | ❌ 未捕获 | 整篇序列化在已归一化内容上是**幂等**的，两条路径收敛 |
| 去掉区间越界守卫 | ✅ 捕获 | — |

修法：fixture 里未改动块的 DB 文本**故意带归一化**；再加一条用例**手工把文件改成序列化器不会产出的形态**（行尾双空格），只改另一个块，断言前一块的磁盘字面排版幸存。此后「关闭局部改写」被捕获。

**教训：「测试全绿」在没有变异验证前不构成证据**，尤其当机制的价值就是「让两份本应不同的东西保持不同」时，极易写出自我实现的测试。

### P2 完成（`34f8ca4`）

路径归属做成**档位**，而不是直接改默认值：

| 档位 | 路径来源 | 默认 |
|---|---|---|
| `system` | `<首标签\|untagged>/<slug>--<id12>.md`（派生） | ✅ 是 |
| `user` | 首次 `<标题>.md`（无 id 后缀），此后**以磁盘为准** | 否 |

**为什么默认必须是 `system`**：影子副本对既有用户是默认开启的，把它改成 `user` 会让所有
人的文件同时搬位置。D7 早已把两档分开，P2 只是让「路径归谁」成为档位的一个属性。

`user` 档位下：用户改名 / 移动文件被保留（路径不再由标题派生），文档标题变化**不搬文件**，
旧的派生路径不会被删除。重名追加 ` (n)`。

**一个必须显式处理的冲突**：切到 `user` 时，「磁盘为准」会把**切换前**那条 system 派生路径
当成「用户已定的路径」沿用，于是永远摘不掉 `--<id12>` 后缀（实测踩过：切了档位文件名原封不动）。
**裁决**：切换是显式用户动作，语义就是「我要可读文件夹」，因此这一次允许重算路径；
但把旧文件 rename 过去，不丢用户在外面做的编辑。

**顺带修掉的真 bug**：标题行陈旧。走局部改写路径时标题行是照抄磁盘的，于是改名之后
文件里的 `# 标题` 永远停在旧值。改为按**当前**标题重写。

**测试**：10 条新用例。三次变异全部被捕获（关掉磁盘为准 → 3 条失败；默认档位改成 user →
既有布局用例失败；标题照抄磁盘 → 改名用例失败）。

### P3 进行中：入方向导入

**新增依赖决策**：`next` 的 vault watcher 依赖 `chokidar@^4`，而 `main` 的 `packages/server` **没有这个依赖**。watcher 用到它的三样能力：

| 能力 | 为什么需要 |
|---|---|
| `awaitWriteFinish` | 编辑器一次保存会产生多次 fs 事件，合并后避免把半截文件读进库 |
| `usePolling` + `interval` | 网络盘 / 虚拟盘（Docker bind mount、iCloud）上原生事件不可靠 |
| 忽略规则（函数形式） | 跳过附件目录、`.obsidian`、冲突副本 |

**决定：添加 `chokidar` 依赖。** 理由：
- 这三样能力都要自己写的话，等于重写一个 watcher；而「编辑器保存产生多次事件」是必须处理的实际问题（否则会读到写了一半的文件）
- `next` 上已验证过（含 OrbStack/virtiofs 的实测教训，见 U-2 记录）
- 纯 JS 依赖，无原生编译，不影响 Docker 镜像与 Windows engine 打包

`fs.watch` 的裸用不满足第一条：它在 macOS 上会为一次保存触发多次事件，且不提供稳定性窗口。

### P3 完成（`7aa4e7e` 前置件、`01f81e3` 入方向、`6cdd6ff` 监听）

入方向落地：文件 → 库。新路径建文档，内容变了按指纹对齐子块（复用 `syncMarkdownChildren`，
与编辑器整篇保存同一条路径，保块 id），文件消失 → 文档进回收站。

新增：`projection/{paths,config,watchProbe,watcher,ingest}.ts`、`store/projectionFiles.ts`、迁移 024。
**新增依赖 `chokidar`**（理由见下）。

**接线中修掉的三个真 bug**（都是测试先失败才发现的）：

1. **映射行不该删**。文件消失时我最初删掉了 `projection_files` 行，导致文件再出现时走 `created`
   分支、库里多一篇重复文档。改为**保留映射行**：它的生命周期跟着「投影关系」走，而不是
   「文件当前在不在」——文件可能只是被临时移走又移回来（git 切分支、同步中间态）。
   只在文档被**永久删除**时才清。
2. **短路必须看文档存活**。`sha 未变 → unchanged` 这条短路让「内容一个字节没变、但文档还在回收站」
   的文件永远出不来。补上 `getLiveDocById` 判定。
3. **移动检测不能只看内容**。最初按 `content_sha256` 配对，于是**任何两篇内容相同的笔记会被并成一篇**
   ——这对用户是完全正常的用法。改为两个条件缺一不可：候选的 `rel_path` 确实已不在磁盘上，
   **且**其文档处于软删除状态。

**一个测试方法论的教训**：第 3 条的守卫有两道，而它们在「两个文件都在磁盘上」的场景里**重叠**——
去掉一道仍被另一道挡住，变异测试不会报警。只有「文件已从磁盘消失、但文档还活着」（watcher 宽限窗口内）
这个状态能单独覆盖第二道。补上这条针对性用例后变异才被捕获。**两道守卫重叠时，必须为每道单独造场景。**

### 出方向的图片策略（D10 待接线）

P1b 已让出方向支持局部改写，但 **D10 的附件策略（`<笔记名>.assets/` + 相对路径）尚未接线**：
现在投影文档的图片仍写 `asset:<sha>` 指向 `data/media/`，拷走文件夹会碎图。
这是 D10 承诺的核心价值，列为 P4 的前置项。

### P4 完成（`94e191e` 写回与冲突、`6e5191f` 状态）

- `projection/writeback.ts` 把出方向接起来：读盘 → 乐观并发校验 → 局部改写或整篇 → 原子写 → 刷新映射指纹。
- `projection/conflict.ts` + `audit.ts` 实现 D5：**库赢**，外部版本落 `<stem>.notefast-conflict-<stamp>.md`。
  副本是普通文件，会被 watcher 导入，用户看得见、可自行合并。
- `projection/status.ts` 报出 `files / liveFiles / patchableFiles / conflicts`，扩展 `/api/v1/instance` 的
  `projection` 字段（S3：只做加法）。

**回声抑制的全部实现**就是「写回成功后刷新映射指纹」：随后 watcher 收到的事件会在 ingest 的
sha 短路处命中 `unchanged`，不需要任何「正在写」标记。已由用例钉住。

**接线中修掉的三处口径错误**（都是先失败再发现）：

1. **整篇路径只序列化了文档根**，产出 `# 标题` 一行、正文全丢。改用既有的 `portableDocMarkdown`。
2. **区间偏移口径与 ingest 不一致**：写回侧多剥了一层标题行，导致块数与区间对不上、
   区间表整体失效，且文件里出现两个 H1。统一为**只剥 frontmatter**——
   标题行在库里是一个真实的 heading 块（当它与文件名不同时尤其明显），必须参与对齐。
3. **测试期望错误**：我一度断言「与文件名同文的 H1 会被剥掉」是错的。

**一个既有限制（不是本次引入），已用用例钉住**：当正文首行是「与文件名同文的 H1」时，
`insertDocFromMarkdown` 会剥离它，但区间记录按完整 body 解析 → 解析 2 块 vs 库里 1 块 →
对齐失败 → **这类文件永久退回整篇序列化**（内容不丢不重复，只是排版不再逐字节保留）。
与 vault V-203 记录的「整篇退回后无法重建区间」同源。

**实测的文件形态覆盖**：

| 形态 | 区间 | 模式 | 往返一致 |
|---|---|---|---|
| 纯正文 | ✅ | patch | ✅ |
| 标题与文件名不同 | ✅ | patch | ✅ |
| 无标题多段 | ✅ | patch | ✅ |
| 引用块 | ✅ | patch | ✅ |
| 带 frontmatter | ✅ | patch | 内容一致（`tags: [x]` 归一为块列表）|
| 标题与文件名相同 | ❌ | full | 内容一致，排版归一 |

## 实施路径

**注意排序约束**：span 原语在 `next` 上，不在 `main` 上（见 §前置约束）。阶段 P1 之前必须先搬 core。

| 阶段 | 内容 | 前置 |
|---|---|---|
| P0 | 把 shadowMarkdown 拆成「投影引擎 + 两种档位」（D7），行为保持不变 | 无 |
| P1a | **搬 core 原语**：`parseMarkdownToBlocksWithSpans` + `patchFrontmatter` + 两个测试文件（约 172 行 + 测试） | 无 |
| P1b | 搬 `patch.ts` / `spans.ts` / `writer.ts` / `lock.ts` / 迁移 025（逐字节），出方向改用局部写回 | P0、P1a |
| P2 | 路径归用户：`doc_id ↔ rel_path` 映射 + 改名/移动跟随（D2） | P1b |
| P3 | 入方向导入：watcher + 增量导入（D6），复用 `watcher` / `watchProbe`，剥掉 rename 配对 | P2 |
| P4 | 冲突副本 + 审计 + 状态端点（D5、S3）；补块级变更信号 | P3 |
| P5 | 收敛导出路径（S1、S2），更新 AGENTS.md（S5） | P4 |

**P1a + P1b 是独立价值，可以先单独落地。** 即使不做双向，让只读投影也改用局部写回，可以消掉「每次变更整篇重序列化 + 重写整份 manifest（O(n)）」的开销——RFC 0006 已指出这正是影子副本在 vault 下被强制关闭的原因之一。

## 开放问题

**已决**（2026-09-26 用户确认）：

- ~~冲突裁决方向~~ → **D5：SQLite 赢**
- ~~删除语义~~ → **D9：双向同步删除，恢复靠库的软删除（`POST /blocks/:id/restore` 已是现成路径）**
- ~~附件策略~~ → **D10：单一实现，投影文档用 `<笔记名>.assets/` + 相对路径；无投影的库文档继续 `asset:<sha>`**

**待定**：

1. **默认目录模板**要不要支持 `{tag}` / `{year}` 之类的占位符？倾向支持但默认空白（全部放根目录），避免替用户分类。
2. **首次开启时的存量处理**：文件夹里已经有用户自己的 `.md`，是全部导入、还是只建立映射不导入？倾向**导入**（否则用户看不到自己的文件在库里）。注意这条会影响 D9——导入进来的文件如果用户删掉，文档会进回收站，这可能不是他期望的。
3. 是否提供一个「**一键切换到 vault 模式**」的迁移路径，给确认需要「文件永远赢」的用户？——这在投影方案下变成「提升 SQLite 的作用域」，实现成本可控。
4. **D9 的一个细节**：用户在文件夹里删掉一个从没被导入过的 `.md`（无映射），不产生任何动作——这是对的。但如果他删掉的是一个**已导入**的文件，文档进回收站，这会让「我只是整理文件夹」变成「我删了笔记」。是否需要一个「投影文件夹的删除不进回收站、只解除映射」的选项？倾向**不提供**（两个语义会让用户猜），但在首次开启的说明里写清楚。

## 与 `next` 分支的关系

`next` 已有的 93 个提交是**本方案的主要零件来源**，不是废弃工作。建议：

- **不要**把 `next` 合进 `main`（那会引入第二权威与模式分叉）。
- **按模块搬运**：只取「复用清单」里的模块，代码评审时逐个确认不引入 vault 特有假设。
- `next` 保留为参考实现；RFC 0001–0006 保留为决策记录（它们记录的问题与实测教训仍然有效，例如 watcher 探测的文件系统先验、`$$` → ```math 的行号偏移处理、局部写回的兜底策略）。
