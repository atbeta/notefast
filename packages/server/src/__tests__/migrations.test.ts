/**
 * 迁移幂等与框架清理：旧引擎不得抹掉未知（更新）迁移记录；
 * ADD COLUMN 在列已存在时不能让启动崩溃。
 */

import { describe, test, expect, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { runMigrations } from '../migrations/framework'
import { up as up008 } from '../migrations/008_asset_remote_url'
import { up as up009 } from '../migrations/009_asset_upload_error'
import { up as up010 } from '../migrations/010_asset_upload_attempted_at'
import { up as up019 } from '../migrations/019_assets_filename'

let db: Database | null = null

afterEach(() => {
  db?.close()
  db = null
})

function emptyDb(): Database {
  const d = new Database(':memory:')
  db = d
  return d
}

describe('runMigrations', () => {
  test('不删除未知的未来迁移记录', () => {
    const d = emptyDb()
    runMigrations(d)
    d.query('INSERT INTO schema_migrations (id, description) VALUES (?, ?)').run(
      '099_future_feature',
      'not in this binary',
    )
    runMigrations(d)
    const row = d.query('SELECT id FROM schema_migrations WHERE id = ?').get('099_future_feature')
    expect(row).toEqual({ id: '099_future_feature' })
  })

  test('仍清理 squash 前的历史迁移 id', () => {
    const d = emptyDb()
    runMigrations(d)
    d.query('INSERT INTO schema_migrations (id, description) VALUES (?, ?)').run(
      '003_properties_columns',
      'squashed',
    )
    runMigrations(d)
    const row = d.query('SELECT 1 AS ok FROM schema_migrations WHERE id = ?').get('003_properties_columns')
    expect(row).toBeNull()
  })
})

describe('assets ADD COLUMN 迁移幂等', () => {
  test('列已存在时 008/009/010/019 仍可 up', () => {
    const d = emptyDb()
    d.exec(`
      CREATE TABLE assets (
        id TEXT PRIMARY KEY,
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        remote_url TEXT,
        upload_error TEXT,
        upload_attempted_at TEXT,
        filename TEXT
      )
    `)
    expect(() => {
      up008(d)
      up009(d)
      up010(d)
      up019(d)
    }).not.toThrow()
  })
})
