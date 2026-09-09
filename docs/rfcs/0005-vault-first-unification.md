# RFC 0005: vault-first 统一 — 模式差异只在引擎

- 状态：草案（待确认）
- 日期：2026-09-09
- 依赖：RFC 0001（vault 模式）、0002（身份与 ingest）、0003（写回与冲突）、0004（文件同步）
- 相关：`docs/plans/vault-mode.md`（任务登记）、`AGENTS.md`（分支与门禁纪律）

## 摘要

NoteFast 有两种 notebook 模式：`kind='db'`（SQLite 权威）与 `kind='vault'`（文件夹权威）。两者共存是 RFC 0001 D1 的刻意选择，代价是三类混乱：用户不知道自己处于哪个模式、数据落在哪；**同一份代码在不同部署方式下行为分叉**（桌面壳 / Docker / 裸 `bun`）；从一种模式切到另一种等于换了一个知识库。

本 RFC 定下统一方向：**vault 是默认心智模型，db 冻结为 legacy**；并把「模式差异只能由引擎表达，不能由部署方式表达」写成硬约束。统一不是删除 db 模式，而是让「指向一个文件夹」成为所有部署方式的同一个动作。

## 问题

### P1 模式不可见

- 设置页 vault 项在 db 模式下**整项隐藏**（`packages/web/src/routes/settings/index.tsx:36` 用 `isVaultEnabled` 过滤）→ 用户以为功能不存在（已实际发生）
- 没有任何「当前来源 / 数据位置」指示；`DATA_DIR` 不经 API 暴露，只有桌面壳自己显示

### P2 部署方式分叉（同一份代码，行为不同）

| 维度 | 桌面壳 | Docker | 裸 `bun` |
|---|---|---|---|
| 模式入口 | GUI 选文件夹 | 只能 env | 只能 env |
| 索引位置 | 派生 `<应用支持目录>/<sha256 前12位>` | 固定 `/app/data` | 固定 `DATA_DIR` |
| watcher | 原生事件 | Docker Desktop 必须手开轮询 | 原生事件 |
| 默认模式 | db（除非点菜单） | db（除非改 env） | db |

差异本身都合理，问题在于**它们是按部署方式写死的，而不是由引擎判定的**：用户从 Docker 换到桌面壳，要重新学一遍规则。

### P3 切换 = 换库

- RFC 0001 D7 明确不做原地转换；从 vault 模式回到 db 模式看到的是空库，体感像「数据丢了」
- 壳不自动重开上次 vault（V-403 待议）

### P4 parity 缺口（统一的前置条件）

| 缺口 | 现状 |
|---|---|
| 修订历史 | `packages/server/src/api/docs.ts:453` `shouldSnapshot = checkpoint && !isVaultNotebook` → vault 不记 `doc_snapshots`，`/docs/:id/snapshots/:rev/restore` 在 vault 下无用 |
| 分享身份 | `shares` 按 doc id + token 存；vault 索引可重建 → 重建后 id 变、链接失效。写回又刻意不写 `notefast_id`（RFC 0001 D2/D3） |
| 性能 | 10k 文件首次对账 258–280s，瓶颈是 `vault/wikilinks.ts#syncVaultWikilinks` 每次 ingest 重建全量文件索引（O(n²)）；db 模式写入是毫秒级 |

## 决策记录

### D1 模式差异只能由引擎表达

桌面壳、Docker、裸 `bun` 共用 `packages/server/src/native/bootstrap.ts` 的契约。任何与模式相关的判定（是否 vault、索引放哪、用不用轮询）**必须在引擎里做出并上报**；部署方式只负责「提供路径」。

推论：壳不再持有「vault 模式」概念，只传路径；`docker-compose.yml` 不编码业务规则，只提供挂载与 env。

### D2 vault 是新安装的默认

`VAULT_PATH` 未设且用户未显式选择 db 时，引导选择文件夹。db 模式**冻结为 legacy**：保留可用、只修 bug、不加新功能，`/api/v1` 契约照旧（只做加法）。

### D3 索引位置规则统一

vault 模式下索引一律派生为 `<父目录>/<sha256(canonical vault path) 前 12 位>`：

- 父目录 = 显式 `NOTEFAST_APP_SUPPORT_DIR`，否则应用支持目录（`bootstrap.ts:96`，已含 macOS / Windows / XDG 三平台口径）
- 显式 `--data-dir` / `DATA_DIR` 仍然优先（排障与既有部署）
- Docker 传 `NOTEFAST_APP_SUPPORT_DIR=/app/data`，于是容器与壳的规则完全相同：一个 vault 一个索引，切 vault 不会复用旧索引

### D4 watcher 自动探测，而不是按平台写死

启动时（仅 vault 模式）探测 vault 根是否投递原生事件（写临时文件 + 短超时等待），失败则自动降级轮询；**实际生效的模式**报进 `/vault/status`。`VAULT_USE_POLLING` 保留为强制覆盖。

理由：Linux 宿主的 bind mount 能投递 inotify，硬性统一成轮询等于白吃 1 秒延迟。这里要的是**行为一致**（自动得出正确模式），不是配置一致。

### D5 可见性统一

新增只读模式端点（模式 / vault 根 / 索引目录 / 实际 watcher 模式 / 版本），设置页常显「数据来源」区块，db 模式下不再隐藏，而是显示当前模式 + 如何切换到 vault。

### D6 修订历史 = 索引侧的本地缓存

对齐 Obsidian File recovery 的模型（2026-09 官方文档）：

| Obsidian | NoteFast 对应做法 |
|---|---|
| 快照存 Global settings，**vault 之外**（官方理由：防 vault 本身丢失） | 存 `DATA_DIR`，不写进文件夹、不进 git、不参与文件同步 |
| 按**绝对路径**存，移动 vault 后历史失效（官方明列的限制） | 键用 **`rel_path`**，移动文件夹不失效 |
| 只快照变过的文件、整篇内容 | 内容按 **sha256 去重**（复用 `vaultBlobKey` 思路），未变内容不重复占空间 |
| 默认最短 5 分钟 / 保留 7 天，可配 | 沿用 db 模式「每篇保留 50 条」，时间上限可配 |
| 官方定位「不是完整备份方案」 | 长期历史交给 git / Time Machine，索引内快照只做「最近若干次误改的后悔药」 |

**恢复必须走写回**：vault 下的恢复 = 把快照内容写回文件（过同一把 `ctx.lock` + writeback 路径）→ 重新 ingest；只改 SQLite 会被下一次文件变更覆盖。这是本决策的核心实现约束。

不采用「把历史写进 Markdown / frontmatter」：污染用户文件、进 git、被同步工具反复冲突。

### D7 分享身份改用 vault 相对路径

`shares` 从「doc id」改为「`rel_path` + 内容校验」：打开时校验文件存在且 hash 匹配，缺失返回 `410 Gone` 而不是静默 404。理由：vault 索引是可重建的派生数据，任何依赖 doc id 的长期标识都会在重建后失效，而写回又刻意不写 `notefast_id`。

### D8 性能是统一的前置门禁

先修 `syncVaultWikilinks` 的 O(n²)：对账期间构建一次文件索引并沿调用链传递，或 `vault_files` 写入时失效缓存。目标：**10k 文件对账 < 60s**，并给出 50k 不崩的证据。

理由：统一后 db 模式的大库用户会迁到 vault；如果首次对账从「毫秒级写入」变成「十分钟」，统一就是体验倒退。

## 非目标

- 不做块级 CRDT / 自动合并（沿用 RFC 0004 的冲突副本策略）
- 不做 db → vault 的原地转换（迁移仍是一次性投影，见下）
- **不删除 db 模式代码**；「统一」指默认心智模型统一，不是物理删除
- 不把历史写进 Markdown / frontmatter
- 不做端到端加密的历史存储
- 不引入第二个向量库 / 第二个存储后端

## 兼容与迁移

| 场景 | 行为 |
|---|---|
| 既有 Docker **db** 部署 | 完全不变：`DATA_DIR=/app/data` 直用，不派生 |
| 既有 Docker **vault** 部署 | vault 0.90.0 刚发布，索引位置将从 `/app/data` 变为 `/app/data/<hash12>`。检测到 `<父目录>/index.sqlite` 且处于 vault 模式时，**继续使用旧位置并打印警告**，不静默搬库 |
| 既有桌面壳 | 索引位置不变（早已派生），仅 watcher 探测与可见性变化 |
| 新安装（含 Docker） | 默认引导选文件夹（D2） |
| db → vault 迁移 | 仍走 `docs/vault-migration.md`；本 RFC 不承诺无损，只承诺**迁移指引不骗人** |

## 实施阶段

| 阶段 | 内容 | 验收 |
|---|---|---|
| A | 模式端点 + 设置页常显「数据来源」 | API 单测；web 渲染测试覆盖 db / vault 两态 |
| B | watcher 自动探测 | 单测：探测成功走原生 / 失败降级轮询 / 强制覆盖优先；`/vault/status` 回报实际模式 |
| C | 索引位置统一（Docker 父目录语义 + 旧位置兼容） | bootstrap 单测：hash 一致、显式 data-dir 优先、旧索引保留并告警；compose 更新 |
| D | compose 默认启用 vault + README / 迁移文档 | 手工：挂一个文件夹 `docker compose up` 即 vault |
| E | 修订历史（快照 + 写回恢复） | 单测：编辑 → 快照 → 恢复 → 文件内容回退；重建索引后历史消失（断言） |
| F | 分享身份改 `rel_path` | 迁移 + 单测：重建索引后旧链接仍可打开；文件缺失返回 410 |
| G | 对账性能 | 基准回归 10k < 60s |

A–D 是「部署一致性」；E–G 是「统一的前置 parity」。G 与其余阶段可并行。

## 验证

实施后补：A–D 的门禁结果、E 的恢复实测、F 的迁移前后链接对比、G 的 10k / 50k 基准数字。

## 开放问题

- 新安装是否自动创建默认 vault 目录（`~/Documents/NoteFast`），还是强制用户选一个？自动创建对「纯 Docker 首次启动」不适用
- 分享的 `rel_path` 身份在文件改名 / 移动后如何处理：跟随 `vault_files` 的 rename 配对，还是让链接失效
- 历史是否需要跨设备（复用 RFC 0004 的 blob 存储 + 更长保留期）——倾向 v2，且默认关闭
- 是否为 `db` 模式加一次性的「升级即投影」迁移工具（把 db 库导出成带 `notefast_id` frontmatter 的文件夹，让 ingest 认领 doc id 以保住分享 / 引用）——本 RFC 暂不做，但保留为 1.0 前的候选
