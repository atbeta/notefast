import { getDb } from '../db'
import { computeContentHash } from './contentHash'

export interface ApiTokenRecord {
  token_id: string
  name: string
  token_hash: string
  scopes: string
  created_at: string
  last_used_at: string | null
  revoked: number
  expires_at: string | null
}

export interface ApiTokenCreateResult {
  plain: string
  record: ApiTokenRecord
}

function newTokenPlain(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return 'nf_' + Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('')
}

export function createToken(name: string, scopes: string[] = ['read', 'write']): ApiTokenCreateResult {
  const db = getDb()
  const tokenId = crypto.randomUUID()
  const plain = newTokenPlain()
  const tokenHash = computeContentHash(plain)

  db.query(
    `INSERT INTO api_tokens (token_id, name, token_hash, scopes) VALUES (?, ?, ?, ?)`,
  ).run(tokenId, name, tokenHash, JSON.stringify(scopes))

  const record = db.query('SELECT * FROM api_tokens WHERE token_id = ?').get(tokenId) as ApiTokenRecord
  return { plain, record }
}

/** 创建 Web UI 登录会话 token：admin 权限、有时效。remember=7d 否则 24h。 */
export function createWebSessionToken(remember: boolean): { plain: string; tokenId: string } {
  const db = getDb()
  const tokenId = crypto.randomUUID()
  const plain = newTokenPlain()
  const tokenHash = computeContentHash(plain)
  const ttlHours = remember ? 24 * 7 : 24
  const scopes = JSON.stringify(['admin'])

  db.query(
    `INSERT INTO api_tokens (token_id, name, token_hash, scopes, expires_at)
     VALUES (?, ?, ?, ?, datetime('now', ?))`,
  ).run(tokenId, 'web-session', tokenHash, scopes, `+${ttlHours} hours`)

  // 清理所有已过期的 token（旧会话自然过期，不主动撤销以避免多 tab 登录竞态）
  cleanupExpiredTokens()

  return { plain, tokenId }
}

/** 撤销所有 web-session 类型的 token（登出时调用） */
export function revokeWebSessionTokens(): number {
  const db = getDb()
  const result = db
    .query("UPDATE api_tokens SET revoked = 1 WHERE name = 'web-session' AND revoked = 0")
    .run()
  return result.changes
}

export function verifyToken(plain: string): ApiTokenRecord | null {
  const db = getDb()
  const tokenHash = computeContentHash(plain)
  // expires_at 值为 SQLite datetime('now') 格式（YYYY-MM-DD HH:MM:SS），
  // 此格式的字符串按字典序比较等价于时间先后，不需要 parse 为时间戳。
  const row = db
    .query(
      `SELECT * FROM api_tokens
       WHERE token_hash = ? AND revoked = 0
       AND (expires_at IS NULL OR expires_at > datetime('now'))`,
    )
    .get(tokenHash) as ApiTokenRecord | undefined
  if (!row) return null
  return row
}

export function revokeToken(tokenId: string): boolean {
  const db = getDb()
  const result = db
    .query("UPDATE api_tokens SET revoked = 1 WHERE token_id = ? AND revoked = 0")
    .run(tokenId)
  return result.changes > 0
}

export function listTokens(): ApiTokenRecord[] {
  const db = getDb()
  return db
    .query('SELECT * FROM api_tokens WHERE revoked = 0 AND name != ? ORDER BY created_at DESC')
    .all('web-session') as ApiTokenRecord[]
}

export function updateLastUsed(tokenId: string): void {
  try {
    getDb()
      .query("UPDATE api_tokens SET last_used_at = datetime('now') WHERE token_id = ?")
      .run(tokenId)
  } catch {
    /* fire-and-forget */
  }
}

/** 软删除已过期的 token */
export function cleanupExpiredTokens(): number {
  try {
    const result = getDb()
      .query("UPDATE api_tokens SET revoked = 1 WHERE expires_at IS NOT NULL AND expires_at <= datetime('now') AND revoked = 0")
      .run()
    return result.changes
  } catch {
    return 0
  }
}
