import { getDb } from '../db'

type SqlParam = string | number | null

export interface EntityChange {
  id: number
  entity_name: string
  entity_id: string
  hash: string
  is_erased: number
  is_synced: number
  change_id: string
  component_id: string
  actor: string
  utc_date_changed: string
}

/** 列出某 entity 的所有变更历史（按时间倒序） */
export function listForEntity(entityName: string, entityId: string, limit = 100): EntityChange[] {
  const db = getDb()
  return db
    .query(`
      SELECT id, entity_name, entity_id, hash, is_erased, is_synced, change_id, component_id, actor, utc_date_changed
      FROM entity_changes
      WHERE entity_name = ? AND entity_id = ?
      ORDER BY id DESC
      LIMIT ?
    `)
    .all(entityName, entityId, limit) as EntityChange[]
}

/** 列出最近的变更（审计日志用） */
export function listRecent(opts: {
  since?: string
  actor?: string
  entityName?: string
  limit?: number
} = {}): EntityChange[] {
  const db = getDb()
  const conditions: string[] = []
  const params: SqlParam[] = []

  if (opts.since) { conditions.push('utc_date_changed >= ?'); params.push(opts.since) }
  if (opts.actor) { conditions.push('actor = ?'); params.push(opts.actor) }
  if (opts.entityName) { conditions.push('entity_name = ?'); params.push(opts.entityName) }

  const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : ''
  const limit = opts.limit ?? 100
  params.push(limit)

  return db
    .query(`
      SELECT id, entity_name, entity_id, hash, is_erased, is_synced, change_id, component_id, actor, utc_date_changed
      FROM entity_changes
      ${where}
      ORDER BY id DESC
      LIMIT ?
    `)
    .all(...params) as EntityChange[]
}

/** 列出未同步的变更（同步队列用） */
export function listUnsynced(limit = 1000): EntityChange[] {
  const db = getDb()
  return db
    .query(`
      SELECT id, entity_name, entity_id, hash, is_erased, is_synced, change_id, component_id, actor, utc_date_changed
      FROM entity_changes
      WHERE is_synced = 0
      ORDER BY id ASC
      LIMIT ?
    `)
    .all(limit) as EntityChange[]
}

/** 获取某 entity 的最新变更 */
export function getLatest(entityName: string, entityId: string): EntityChange | null {
  const db = getDb()
  return db
    .query(`
      SELECT id, entity_name, entity_id, hash, is_erased, is_synced, change_id, component_id, actor, utc_date_changed
      FROM entity_changes
      WHERE entity_name = ? AND entity_id = ?
      ORDER BY id DESC
      LIMIT 1
    `)
    .get(entityName, entityId) as EntityChange | null
}

/** 压缩某 entity 的变更记录（保留最近 N 条，删除其余） */
export function compact(entityName: string, entityId: string, keep = 10): number {
  const db = getDb()
  const result = db
    .query(`
      DELETE FROM entity_changes
      WHERE entity_name = ? AND entity_id = ?
        AND id NOT IN (
          SELECT id FROM entity_changes
          WHERE entity_name = ? AND entity_id = ?
          ORDER BY id DESC
          LIMIT ?
        )
    `)
    .run(entityName, entityId, entityName, entityId, keep)
  return result.changes
}
