import type { Database } from 'bun:sqlite'

export const id = '002_web_session_tokens'
export const description = 'add expires_at to api_tokens for revocable web sessions'

export function up(db: Database): void {
  const cols = db.query("PRAGMA table_info('api_tokens')").all() as Array<{ name: string }>
  if (!cols.some((c) => c.name === 'expires_at')) {
    db.exec(`ALTER TABLE api_tokens ADD COLUMN expires_at TEXT`)
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_api_tokens_expires ON api_tokens(expires_at)`)
}
