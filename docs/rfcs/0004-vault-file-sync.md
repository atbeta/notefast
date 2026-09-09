# RFC 0004: vault 文件同步（NoteFast Sync for files）

- 状态：已接受，分阶段实施（P1 引擎 → P2 运行时/API → P3 Web → P4 文档）
- 依赖：RFC 0001（vault 模式）、RFC 0002（身份与 ingest）、RFC 0003（写回与冲突）
- 实现：`packages/server/src/vault/fileSync.ts`、`store/vaultSyncState.ts`、迁移 027、`vault/index.ts`、`storage/*`

## 问题

RFC 0001 D6 规定 vault 模式**不参与** db 模式的变更流同步，因为那套协议同步的是 SQLite 派生索引，在「文件是权威」的前提下等于造出第二个权威。但多端需求并没有消失：

- 移动端（iOS/Android）没有 iCloud / git / Syncthing 客户端，纯靠外部文件同步工具覆盖不到；
- 用户希望「换台机器打开同一个笔记库」是应用内动作，而不是先配好一个第三方同步工具。

同类产品的做法（2026-09 调研）：Obsidian Sync 同步**文件**并生成冲突副本；Syncthing 生成 `*.sync-conflict-*`；SiYuan 同步加密的 `repo/` 增量仓库而不是 `.sy` 文件；Joplin 同步条目；Logseq DB 版与 Anytype 转向 CRDT/RTC。规律是：**要么同步文件，要么同步变更仓库，不能两者都同步**。

本 RFC 选择**同步文件**：文件权威是 vault 模式的立身之本，也是「任何工具都能打开」的前提。

## 范围

目标（v1）：

- 多端文件收敛：新建 / 编辑 / 改名 / 删除，不静默丢内容。
- 复用既有 `data/storage-locations.json`（S3 / WebDAV / LocalFS），不引入新后端、不新增凭据体系。
- 索引自动跟随：文件落盘后由 watcher / reconcile 入库，**不单独同步 SQLite**。
- 对 db notebook 的协议同步零影响；vault notebook 上协议同步强制关闭（见 §与 db 模式同步的关系）。

非目标（v1）：

- 实时协作 / 块级 CRDT（不做，见 RFC 讨论：会牺牲文件权威）。
- 端到端加密：对象存储归用户所有，v1 明文存储；键布局预留（见 §安全）。
- Markdown 自动合并：v1 一律**冲突副本**（不静默合并），自动合并留 v2。
- 增量分块上传：v1 整文件上传，内容寻址天然去重。

## 远端数据模型

```
<prefix>/                         # 例：notefast-vault-sync/
  meta.json                       # { schema: 1, vault_id, created_at }
  blobs/<sha[0:2]>/<sha256>       # 内容寻址：文件字节（跨文件去重）
  manifests/<device_id>.json      # 每设备一份清单分片（写者唯一 → 无并发写冲突）
```

`meta.json` 里的 `vault_id` 是本 vault 的稳定身份（首台设备创建，落进本端状态）：换库 / 误指到别人的前缀时**直接拒绝**，不静默混库。

清单条目：

```ts
interface VaultSyncEntry {
  rel_path: string
  /** 文件内容的 sha256；null = tombstone（本端已删除） */
  blob: string | null
  size: number
  mtime_ms: number
  /** 本端文件最后修改时间（ISO8601）；合并时用它裁决「谁更新」 */
  updated_at: string
  device_id: string
}
```

**为什么按设备分片**：S3 没有原子 CAS，单个 `manifest.json` 会被多端互相覆盖（Joplin 为此引入同步锁，Obsidian 走自有服务端）。分片让每个设备只写自己的对象，读方合并所有分片——与本仓库 db 模式协议 v2 的 `changes/<device_id>/` 同思路。

**合并规则**：以 `rel_path` 为单位取 `updated_at` 最大者；相同则取 `device_id` 字典序较大者（确定性，避免两端各自为政）。tombstone 参与同一规则。

## 本端状态

迁移 027 建表：

```sql
CREATE TABLE vault_sync_state (
  rel_path       TEXT PRIMARY KEY,
  synced_blob    TEXT,          -- 上次与远端一致时的内容 sha（NULL = 上次同步时本地不存在）
  synced_size    INTEGER NOT NULL DEFAULT 0,
  synced_mtime_ms INTEGER NOT NULL DEFAULT 0,
  synced_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
```

语义：`synced_*` 是**三方比较的 base**（base / local / remote）。判断规则：

- 本地文件 sha == `synced_blob` → 本地未变；
- 远端条目 blob == `synced_blob` → 远端未变；
- 两者都变且不同 → 冲突。

`vault_sync_state` 只存文件级状态，与 `vault_files`（文档映射）解耦：即使索引被删，重新对账也不会重复同步。

## 算法

### push（本端 → 远端）

1. 扫描 vault：`.md` + 资源白名单（png/jpg/jpeg/gif/webp/svg/pdf，与 `vault/raw` 一致），跳过忽略目录与符号链接。
2. 逐文件算 sha256 / size / mtime；与 `vault_sync_state` 比对，得到变更集（新增 / 修改 / 删除）。
3. 上传缺失 blob（先 `listObjects(blobs/<sha[0:2]>/<sha>)` 或直接 put，内容寻址幂等）。
4. 读本端分片 → 覆盖变更条目 → 写回（单对象覆盖，无并发）。
5. 更新 `vault_sync_state`（成功落远端后写）。

### pull（远端 → 本端）

1. `listObjects(manifests/)` → 逐个读 → 按 §合并规则 得到远端视图。
2. 对每个远端条目：
   - **本地无 + 远端有** → 下载 blob → `tmp + rename` 落盘。
   - **本地有 + 远端 tombstone**：本地未变 → 删除本地文件（移入 `.trash/`，与写回删除同语义）；本地已变 → 保留本地，记冲突。
   - **两边都有、blob 不同**：本地未变 → 用远端版本快进覆盖；本地已变 → **冲突**：`updated_at` 较新者成为当前文件，较旧者写为 `<stem>.notefast-conflict-<device8>-<yyyyMMdd-HHmmss>.md`（与 RFC 0003 写回冲突副本同形）。
3. 落盘完成后触发一次 light reconcile（`reconcileVault(ctx, { light: true })`）兜底；watcher 正常时它几乎全部 `stat_skipped`。

删除一律进 `.trash/` 而不是真删：与 RFC 0003 一致，用户可自行清理。

### 改名 / 移动

文件同步层只看到「旧路径 tombstone + 新路径同 blob」；由于 blob 内容寻址，不重复上传。文档身份由 RFC 0002 的 sha 配对在 ingest 层保持（`moveVaultFilePath`），引用与向量不丢。

## 触发与调度

| 场景 | 动作 |
|---|---|
| 文件变更（watcher 稳定后） | debounce 3s → push |
| 定时 | 每 `VAULT_SYNC_INTERVAL_SECONDS`（默认 60）→ pull + push |
| 启动 | 先 pull（拿到别端改动）再 reconcile |
| 手动 | `POST /api/v1/vault/sync/push`、`POST /api/v1/vault/sync/pull`、`GET /api/v1/vault/sync/status` |

同步全程走 `ctx.lock`（与 ingest / writeback 共用串行锁），避免落盘与 ingest 交错。

## 与 db 模式同步的关系

`notebooks.kind='vault'` 时，db 模式协议同步**必须**关闭：

- `scheduleSyncNow()` 静默跳过；
- `POST /api/v1/sync/now`、`POST /api/v1/sync/pull` 返回 409 `vault_mode_uses_file_sync`；
- 状态页与 vault 面板提示「vault 模式用文件同步，协议同步已停用」。

原因：协议同步发布的是 `entity_changes` + 块状态，且快照保留 `vault_files`；在 vault 实例上消费快照会替换整库、覆盖映射与块 id，随后按文件重建索引，引用与历史漂移。两个权威并存 = 数据事故。

## 安全

- 凭据沿用 `storage-locations.json`（已有脱敏与测试连接）。
- v1 明文存储：对象存储是用户自己的桶 / 目录；blob 键 = 明文 sha256，便于跨端去重与完整性校验。
- v2 若要 E2EE：`blob` 键改为 `sha256(明文)`，对象体为 `nonce + AES-GCM(明文)`，密钥由用户口令派生（Argon2id），不上传。**键布局已按此预留**（键只依赖明文哈希，不依赖对象体）。

## 已知坑

- **双重同步**：用户既开 iCloud/Dropbox/Syncthing 又开本同步 → 双方互相删 / 反复冲突（Obsidian 官方把「double-syncing」列为已知故障）。状态里检测 `.icloud`、`*sync-conflict*`、`.dropbox`、`.stversions` 等痕迹并在面板告警；不做自动禁用。
- **大小写不敏感文件系统**（macOS/Windows）：`Note.md` 与 `note.md` 在本地是同一个文件。pull 落盘前检测同目录同名不同大小写 → 记冲突，不覆盖。
- **大文件**：v1 整文件传输；PDF / 大图会占内存，状态里给出体积与耗时。
- **时钟**：合并依赖 `updated_at`。设备时钟偏差大会影响 LWW 结果；这是所有 LWW 方案的通病（Obsidian 同样用时间戳），冲突副本保证不丢内容。

## 阶段

| 阶段 | 内容 |
|---|---|
| P1 | 引擎：`vault/fileSync.ts` + `store/vaultSyncState.ts` + 迁移 027；LocalFS 双实例测试 |
| P2 | 运行时：调度、状态、`/api/v1/vault/sync/*`、协议同步短路 |
| P3 | Web：设置页 vault 面板增加同步区块 + i18n |
| P4 | 文档：README、`docs/vault-migration.md`、`docs/plans/vault-mode.md` 状态 |

## 验证

- 两实例（两个 `DATA_DIR`）经一个 LocalFS 目录同步：
  - 新建 / 编辑 / 改名 / 删除 各自收敛；
  - 双方同时改同一文件 → 两侧都有两个版本，较新者为当前文件，另一个为 `.notefast-conflict-*`；
  - 重复 push/pull 幂等（不产生新对象、不改文件 mtime）；
  - 文件落盘后索引跟随（`GET /api/v1/vault/status.files` 与搜索命中）。
- 1000 文件首次 push/pull 计时记入 `docs/rfcs/0002-block-identity.md` §验证标准（或本 RFC 附录）。
