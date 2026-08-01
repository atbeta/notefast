/**
 * 同步协议类型（方案 A：客户端与 Web 共享同一份 S3）
 *
 * 无账号体系：身份 = 存储位置 + 凭据，不做设备级区分。S3 布局：
 *
 *   {prefix}sync/
 *   ├── snapshot.db            # 全量基线（VACUUM INTO，复用 backup 快照逻辑）
 *   ├── snapshot.seq           # 该快照对应的锚点 seq（生成时的 MAX(seq)）
 *   ├── changes/               # 增量日志（追加；分段文件 = 只写新对象，无需读改写）
 *   │   ├── 0000000001-0000000500.jsonl
 *   │   ├── 0000000501-0000001200.jsonl
 *   │   └── ...
 *   └── manifest.json          # { last_seq, snapshot_seq, updated_at }
 *
 * 语义：
 * - seq = entity_changes.seq（AUTOINCREMENT 单调递增，blocks 表 trigger 驱动）
 * - 增量文件每行 = 一条变更 + 该块变更后的完整状态（content/parent/sort/level），
 *   接收端按 updated_at LWW 裁决后 upsert；delete = tombstone（is_erased）
 * - 超窗（增量被清理）或首次同步 → 拉 snapshot.db 全量重建本地库
 */

/** 同步 S3 布局的目录名 */
export const SYNC_S3_DIR = 'sync'

/** 增量日志每段最大变更条数（分段追加；超出写新对象） */
export const CHANGES_PER_SEGMENT = 500

/** 增量行：一条变更事件 + 变更后块状态（重放/合并用） */
export interface SyncChange {
  /** entity_changes.seq */
  seq: number
  entity: string
  entity_id: string
  /** 1 = tombstone（软删除或硬删除） */
  is_erased: number
  actor: string
  changed_at: string
  /** 变更后的块状态（is_erased=1 时省略，只发 tombstone） */
  block?: SyncBlockState
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
}

/** S3 同步根 manifest：各端同步起点 */
export interface SyncManifest {
  app: 'notefast'
  kind: 'sync'
  version: 1
  /** 当前增量日志的终点锚点（新同步端从这里开始或拉全量） */
  last_seq: number
  /** 快照对应的锚点 seq（生成快照时的 MAX(seq)）；0 = 尚无快照 */
  snapshot_seq: number
  updated_at: string
}

/** 增量文件命名：{seqStart}-{seqEnd}.jsonl（两端 seq 区间，顺序追加） */
export function buildChangesKey(prefix: string, seqStart: number, seqEnd: number): string {
  return `${prefix}${SYNC_S3_DIR}/changes/${String(seqStart).padStart(10, '0')}-${String(seqEnd).padStart(10, '0')}.jsonl`
}

/** 全量快照 key */
export function buildSnapshotKey(prefix: string): string {
  return `${prefix}${SYNC_S3_DIR}/snapshot.db`
}

/** 快照锚点 seq key */
export function buildSnapshotSeqKey(prefix: string): string {
  return `${prefix}${SYNC_S3_DIR}/snapshot.seq`
}

/** manifest key */
export function buildSyncManifestKey(prefix: string): string {
  return `${prefix}${SYNC_S3_DIR}/manifest.json`
}
