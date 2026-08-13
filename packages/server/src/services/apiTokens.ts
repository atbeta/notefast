import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { getDb } from '../db'
import { computeContentHash } from './contentHash'
import { safeLogWarn } from '@notefast/core'

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

/**
 * 启动期检测 AUTH_PASSWORD 是否变更：变更即撤销全部 web-session 会话 token。
 *
 * 背景：Web 登录（POST /auth/session）会生成持久化 web-session token（api_tokens 表，
 * 7 天滑动过期），浏览器存于 localStorage 并作为 Bearer 发送——这类 token 与密码无关，
 * 改密码（docker-compose 等 env 变更后重启）时不会自然失效；cookie 侧由 HMAC 密钥变化
 * 自动作废，唯独 DB token 残留。此函数在 initDb 时比对 `data/auth.state.json` 里记录的
 * 密码指纹，不一致（改/增/删密码均触发）则批量撤销，让旧会话下次请求即 401。
 */
export function revokeWebSessionsIfPasswordChanged(dataDir: string): void {
  const current = passwordFingerprint()
  const statePath = join(dataDir, 'auth.state.json')
  let prev: string | null = null
  try {
    const raw = JSON.parse(readFileSync(statePath, 'utf-8')) as { passwordFingerprint?: unknown }
    if (typeof raw?.passwordFingerprint === 'string') prev = raw.passwordFingerprint
  } catch {
    /* 无状态文件（首次启动）：只记录指纹，不撤销 */
  }

  if (prev !== null && prev !== current) {
    revokeWebSessionTokens()
  }
  if (prev !== current) {
    try {
      if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
      writeFileSync(statePath, JSON.stringify({ passwordFingerprint: current }, null, 2) + '\n', 'utf-8')
      try { chmodSync(statePath, 0o600) } catch { /* Windows 不支持 */ }
    } catch (e) {
      safeLogWarn('auth.state.write_failed', { error: String(e) })
    }
  }
}

/** 密码指纹：AUTH_PASSWORD 的 sha256（未配置时为空串的指纹，增/删密码同样触发变更） */
function passwordFingerprint(): string {
  const pw = (process.env.AUTH_PASSWORD || '').trim()
  return createHash('sha256').update(pw).digest('hex')
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

/** last_used_at 节流窗口：窗口内同一 token 的请求不再逐次写库（进程重启丢最后一段，可接受） */
const LAST_USED_THROTTLE_MS = 60_000
/** token_id → 最近一次写库时间戳（内存级节流；Map 有界——token 总量极小，无淘汰必要） */
const lastUsedWrittenAt = new Map<string, number>()

export function updateLastUsed(tokenId: string): void {
  try {
    const now = Date.now()
    const prev = lastUsedWrittenAt.get(tokenId) ?? 0
    if (now - prev < LAST_USED_THROTTLE_MS) return
    lastUsedWrittenAt.set(tokenId, now)
    getDb()
      .query("UPDATE api_tokens SET last_used_at = datetime('now') WHERE token_id = ?")
      .run(tokenId)
  } catch {
    /* fire-and-forget */
  }
}

/** 测试钩子：清空节流表（并返回删除项数） */
export function _resetLastUsedThrottleForTests(): number {
  const n = lastUsedWrittenAt.size
  lastUsedWrittenAt.clear()
  return n
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
