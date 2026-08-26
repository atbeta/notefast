/**
 * 固定视图：侧栏「固定视图」的读写，REST 与 MCP 共用。
 *
 * query 与首页 URL 搜索串同构（无前导 ?），例如 tags=work、untagged=1、
 * tags=work,ai&tag_match=any、stale_within=90d、ai_exclude=1。
 */

import { getDb } from '../db'

export const MAX_PINNED_VIEWS = 50

export interface PinnedViewRow {
  id: string
  name: string
  query: string
  created_at: string
}

export class PinnedViewError extends Error {
  constructor(
    public readonly code: 'invalid_params' | 'limit' | 'not_found',
    message: string,
  ) {
    super(message)
    this.name = 'PinnedViewError'
  }
}

/** 去掉 / 与 ? 前缀，与 Web canonicalViewQuery 对齐 */
export function canonicalPinnedQuery(q: string): string {
  return q.trim().replace(/^\/+/, '').replace(/^\?+/, '')
}

export interface PinViewInput {
  name: string
  /** 原始 query；与结构化字段二选一（query 优先） */
  query?: string
  tags?: string[]
  tag_match?: 'all' | 'any'
  untagged?: boolean
  ai_exclude?: boolean
  status?: 'inbox' | 'archived' | 'all'
  updated_within?: '24h' | '7d' | '30d'
  created_within?: '24h' | '7d' | '30d'
  stale_within?: '30d' | '90d'
}

const WITHIN = ['24h', '7d', '30d'] as const
const STALE = ['30d', '90d'] as const
const STATUS = ['inbox', 'archived', 'all'] as const
const TAG_MATCH = ['all', 'any'] as const

function pickEnum<T extends readonly string[]>(v: unknown, allowed: T): T[number] | undefined {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T[number]) : undefined
}

/** 把 LLM / MCP 松散参数收成 PinViewInput（缺字段则省略） */
export function pinViewInputFromUnknown(args: Record<string, unknown>): PinViewInput {
  const tags = Array.isArray(args.tags)
    ? args.tags.filter((t): t is string => typeof t === 'string' && t.trim() !== '')
    : undefined
  return {
    name: typeof args.name === 'string' ? args.name : '',
    query: typeof args.query === 'string' ? args.query : undefined,
    tags: tags?.length ? tags : undefined,
    tag_match: pickEnum(args.tag_match, TAG_MATCH),
    untagged: args.untagged === true,
    ai_exclude: args.ai_exclude === true,
    status: pickEnum(args.status, STATUS),
    updated_within: pickEnum(args.updated_within, WITHIN),
    created_within: pickEnum(args.created_within, WITHIN),
    stale_within: pickEnum(args.stale_within, STALE),
  }
}

export function buildPinnedViewQuery(input: PinViewInput): string {
  if (input.query != null && input.query.trim() !== '') {
    const q = canonicalPinnedQuery(input.query)
    if (!q) throw new PinnedViewError('invalid_params', 'query 不能为空')
    return q
  }
  const q = new URLSearchParams()
  if (input.untagged) {
    q.set('untagged', '1')
  } else if (input.tags && input.tags.length > 0) {
    q.set('tags', input.tags.map((t) => t.trim().toLowerCase()).filter(Boolean).join(','))
    if (input.tag_match === 'any') q.set('tag_match', 'any')
  }
  if (input.updated_within) q.set('updated_within', input.updated_within)
  if (input.created_within) q.set('created_within', input.created_within)
  if (input.stale_within) q.set('stale_within', input.stale_within)
  if (input.ai_exclude) q.set('ai_exclude', '1')
  if (input.status) q.set('status', input.status)
  const s = q.toString()
  if (!s) throw new PinnedViewError('invalid_params', '需要 query，或至少一项筛选（tags / untagged / stale_within 等）')
  return s
}

type PinnedViewsListener = () => void
const pinnedViewsListeners = new Set<PinnedViewsListener>()

/** 固定视图有增删改时广播；SSE 复用 /api/v1/events，前端 refetch 列表即可 */
export function publishPinnedViewsChange(): void {
  for (const fn of pinnedViewsListeners) {
    try {
      fn()
    } catch (e) {
      console.warn('[pinnedViews] listener error:', e instanceof Error ? e.message : e)
    }
  }
}

export function subscribePinnedViewsChanges(fn: PinnedViewsListener): () => void {
  pinnedViewsListeners.add(fn)
  return () => {
    pinnedViewsListeners.delete(fn)
  }
}

export function listPinnedViews(): PinnedViewRow[] {
  const db = getDb()
  return db.query('SELECT id, name, query, created_at FROM pinned_views ORDER BY created_at DESC').all() as PinnedViewRow[]
}

export function createPinnedView(input: PinViewInput): { view: PinnedViewRow; created: boolean } {
  const name = input.name.trim().slice(0, 50)
  if (!name) throw new PinnedViewError('invalid_params', 'name 不能为空')
  const query = buildPinnedViewQuery(input)

  const db = getDb()
  const existing = db.query('SELECT id, name, query, created_at FROM pinned_views WHERE query = ?').get(query) as PinnedViewRow | undefined
  if (existing) return { view: existing, created: false }

  const count = (db.query('SELECT count(*) AS n FROM pinned_views').get() as { n: number }).n
  if (count >= MAX_PINNED_VIEWS) {
    throw new PinnedViewError('limit', `固定视图最多 ${MAX_PINNED_VIEWS} 个`)
  }

  const id = crypto.randomUUID()
  db.query('INSERT INTO pinned_views (id, name, query) VALUES (?, ?, ?)').run(id, name, query)
  const row = db.query('SELECT id, name, query, created_at FROM pinned_views WHERE id = ?').get(id) as PinnedViewRow
  publishPinnedViewsChange()
  return { view: row, created: true }
}

export function deletePinnedView(id: string): boolean {
  const db = getDb()
  const row = db.query('SELECT id FROM pinned_views WHERE id = ?').get(id)
  if (!row) return false
  db.query('DELETE FROM pinned_views WHERE id = ?').run(id)
  publishPinnedViewsChange()
  return true
}

export function updatePinnedView(id: string, patch: { name?: string; query?: string }): PinnedViewRow {
  const db = getDb()
  const row = db.query('SELECT id FROM pinned_views WHERE id = ?').get(id)
  if (!row) throw new PinnedViewError('not_found', '固定视图不存在')
  if (patch.name !== undefined) {
    const name = patch.name.trim().slice(0, 50)
    if (!name) throw new PinnedViewError('invalid_params', 'name 不能为空')
    db.query('UPDATE pinned_views SET name = ? WHERE id = ?').run(name, id)
  }
  if (patch.query !== undefined) {
    const query = canonicalPinnedQuery(patch.query)
    if (!query) throw new PinnedViewError('invalid_params', 'query 不能为空')
    db.query('UPDATE pinned_views SET query = ? WHERE id = ?').run(query, id)
  }
  const updated = db.query('SELECT id, name, query, created_at FROM pinned_views WHERE id = ?').get(id) as PinnedViewRow
  publishPinnedViewsChange()
  return updated
}
