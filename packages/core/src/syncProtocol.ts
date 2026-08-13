/**
 * 同步协议类型（多端：客户端与 Web 共享同一份对象存储）
 *
 * 无中心账号体系，身份 = 存储位置 + 凭据 + 设备自持标识。Server 与客户端是
 * 对等写入者（peer 模型），每个写端只发布自己的 namespace。S3 布局（v2）：
 *
 *   {prefix}sync/
 *   ├── snapshot.db            # 全量基线（VACUUM INTO，复用 backup 快照逻辑）
 *   ├── snapshot.meta.json     # 快照锚点：{ anchors: { <device_id>: maxSeq } }
 *   ├── changes/               # 增量日志，按设备分桶（追加 = 只写新对象）
 *   │   └── <device_id>/
 *   │       ├── 0000000001-0000000500.jsonl
 *   │       └── 0000000501-0000001200.jsonl
 *   ├── devices/               # 设备注册（每设备一对象，无并发写冲突）
 *   │   └── <device_id>.json   # { device_id, name, last_seen }
 *   └── manifest.json          # { version: 2, devices: {id: lastSeq}, snapshot: {id: seq} }
 *
 * 语义：
 * - seq = entity_changes.seq（AUTOINCREMENT 单调递增，blocks 表 trigger 驱动），
 *   是**设备本地**序号——不同设备的 seq 空间互相独立，不可跨设备比较
 * - 段按发布端 device_id 分桶：{start}-{end} 只在本设备 namespace 内唯一有序，
 *   零填充保证字典序 = 数值序；两个设备写出相同区间互不覆盖
 * - 消费游标 = per-device 高水位 consumed[device_id]：跳过逻辑按段所属设备
 *   比对对应水位；本端自己的段不消费
 * - 增量文件每行 = 一条变更 + 该块变更后的完整状态（content/parent/sort/level），
 *   接收端按 updated_at LWW 裁决后 upsert；delete = tombstone（is_erased）
 * - 每条变更带发布端 device_id（自持身份；从日志可推导设备集合）
 * - 超窗（增量被清理）或首次同步 → 拉 snapshot.db 全量重建本地库，
 *   各设备水位提升到快照锚点，再增量追加快照之后的段
 *
 * 版本迁移：v1 布局（段直接放 changes/ 根、manifest.version=1、单一全局
 * consumedSeq）只在「一个写端 + N 个纯消费端」下成立，多写端会整段跳过静默
 * 丢数据。v2 端检测到 v1 布局即自动迁移（LWW 合并旧段 → 重建 v2 快照），
 * 见 server/src/sync/protocol.ts 的 migrateV1Layout。
 */

/** 同步协议布局版本（manifest.version；v1 = 段无设备分桶 + 单一全局游标） */
export const SYNC_PROTOCOL_VERSION = 2

/** 同步 S3 布局的目录名 */
export const SYNC_S3_DIR = 'sync'

/** 增量日志每段最大变更条数（分段追加；超出写新对象） */
export const CHANGES_PER_SEGMENT = 500

/** 增量行：一条变更事件 + 变更后块状态（重放/合并用） */
export interface SyncChange {
  /** entity_changes.seq（发布端本地序号，只在同 device namespace 内有意义） */
  seq: number
  entity: string
  entity_id: string
  /** 1 = tombstone（软删除或硬删除） */
  is_erased: number
  actor: string
  changed_at: string
  /** 发布端设备自持标识（无中心注册；从日志推导设备集合） */
  device_id?: string
  /** 删除事件的发生时间（is_erased=1 时附带；毫秒精度，来自 trigger 记录的行 updated_at）。
   *  消费端以此做 LWW 裁决而非消费时刻；旧发布端缺省时回退 changed_at（秒精度） */
  deleted_at?: string
  /** 变更后的块状态（is_erased=1 时省略，只发 tombstone） */
  block?: SyncBlockState
}

/** 设备注册记录（{prefix}sync/devices/<id>.json，每设备一对象） */
export interface SyncDevice {
  device_id: string
  name?: string
  last_seen?: string
}

/** 块的可同步状态（重放时用于 upsert；缺省字段由接收端按缺省值补全） */
export interface SyncBlockState {
  id: string
  notebook_id: string
  parent_id: string | null
  root_id: string
  type: string
  content: string
  properties: string
  tags: string
  status: string
  ai_exclude: number
  sort: number
  level: number
  created_at: string
  /** LWW 裁决字段（内容最后编辑时间） */
  updated_at: string
  /** 远端软删状态（发布端 SELECT * 本就带此列，这里补类型）。「已软删块上的非 erase
   *  变更」必须按原样写入，缺省按 0（活）处理——旧消费端硬编码 0 会把块复活 */
  is_deleted?: number
}

/** S3 同步根 manifest（v2）：协议版本标记 + 各设备增量终点提示 + 快照锚点副本 */
export interface SyncManifest {
  app: 'notefast'
  kind: 'sync'
  version: 2
  /** 各设备增量日志终点锚点（各发布端读改写维护自己的条目；并发写丢更新只让
   *  提示偏旧——消费端以实际段列表为准，不依赖此表，故无害）。仅作展示/提示 */
  devices: Record<string, number>
  /** 当前快照的 per-device 锚点（snapshot.meta.json 的冗余副本，省一次请求；
   *  空对象 = 尚无快照） */
  snapshot: Record<string, number>
  updated_at: string
}

/** 快照元数据（{prefix}sync/snapshot.meta.json，随 snapshot.db 一起覆写） */
export interface SyncSnapshotMeta {
  version: 2
  /** 生成快照的设备 id */
  created_by: string
  created_at: string
  /** 快照内容实际覆盖到的各设备 seq 高水位（= 生成端的 {self: 本地锚点, ...已消费水位}）。
   *  绝不能超出快照内容真实覆盖范围——虚报锚点会让消费端跳过未合并的段，静默丢数据 */
  anchors: Record<string, number>
}

/** 增量文件命名：changes/<device_id>/{seqStart}-{seqEnd}.jsonl（设备分桶，零填充保序） */
export function buildChangesKey(prefix: string, deviceId: string, seqStart: number, seqEnd: number): string {
  return `${prefix}${SYNC_S3_DIR}/changes/${deviceId}/${String(seqStart).padStart(10, '0')}-${String(seqEnd).padStart(10, '0')}.jsonl`
}

/** 全量快照 key */
export function buildSnapshotKey(prefix: string): string {
  return `${prefix}${SYNC_S3_DIR}/snapshot.db`
}

/** 快照元数据 key（v2：per-device 锚点） */
export function buildSnapshotMetaKey(prefix: string): string {
  return `${prefix}${SYNC_S3_DIR}/snapshot.meta.json`
}

/** v1 遗留：单一全局快照锚点 seq key。v2 不再写入，仅在 v1 迁移检测/清理时引用 */
export function buildSnapshotSeqKey(prefix: string): string {
  return `${prefix}${SYNC_S3_DIR}/snapshot.seq`
}

/** manifest key */
export function buildSyncManifestKey(prefix: string): string {
  return `${prefix}${SYNC_S3_DIR}/manifest.json`
}
