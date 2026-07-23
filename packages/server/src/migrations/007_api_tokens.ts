import type { Database } from 'bun:sqlite'

export const id = '007_api_tokens'
export const description = 'Multi-token auth with scopes (Trilium etapi_tokens pattern)'

export function up(db: Database): void {
  db.exec(`
    CREATE TABLE api_tokens (
      token_id    TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      token_hash  TEXT NOT NULL,
      scopes      TEXT NOT NULL DEFAULT '["read","write"]',
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at TEXT,
      revoked     INTEGER NOT NULL DEFAULT 0
    )
  `)
  db.exec(`CREATE INDEX idx_api_tokens_hash ON api_tokens(token_hash)`)
  db.exec(`CREATE INDEX idx_api_tokens_revoked ON api_tokens(revoked)`)
}

export function down(db: Database): void {
  db.exec(`DROP INDEX IF EXISTS idx_api_tokens_revoked`)
  db.exec(`DROP INDEX IF EXISTS idx_api_tokens_hash`)
  db.exec(`DROP TABLE IF EXISTS api_tokens`)
}
