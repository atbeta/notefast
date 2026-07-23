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
}

export interface ApiTokenCreateResult {
  plain: string
  record: ApiTokenRecord
}

export function createToken(name: string, scopes: string[] = ['read', 'write']): ApiTokenCreateResult {
  const db = getDb()
  const tokenId = crypto.randomUUID()
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  const plain = 'nf_' + Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('')
  const tokenHash = computeContentHash(plain)

  db.query(
    `INSERT INTO api_tokens (token_id, name, token_hash, scopes) VALUES (?, ?, ?, ?)`,
  ).run(tokenId, name, tokenHash, JSON.stringify(scopes))

  const record = db.query('SELECT * FROM api_tokens WHERE token_id = ?').get(tokenId) as ApiTokenRecord
  return { plain, record }
}

export function verifyToken(plain: string): ApiTokenRecord | null {
  const db = getDb()
  const tokenHash = computeContentHash(plain)
  const row = db
    .query('SELECT * FROM api_tokens WHERE token_hash = ? AND revoked = 0')
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
    .query('SELECT * FROM api_tokens WHERE revoked = 0 ORDER BY created_at DESC')
    .all() as ApiTokenRecord[]
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
