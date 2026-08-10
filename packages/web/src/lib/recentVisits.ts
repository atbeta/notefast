/**
 * 本机「最近访问」——侧栏快捷入口用。
 *
 * 不写服务端：访问足迹是本机导航习惯，不进 change feed / 多端同步。
 * 存储：localStorage `notefast.recentVisits` = string[]（最近在前）。
 */

const STORAGE_KEY = 'notefast.recentVisits'
/** 保留上限（侧栏只展示前 15；多留一点给「展开全部」与列表过滤后仍够） */
export const RECENT_VISITS_MAX = 40

const bus = new EventTarget()
const CHANGED = 'changed'

function readIds(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((x): x is string => typeof x === 'string' && x.length > 0)
  } catch {
    return []
  }
}

function writeIds(ids: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids.slice(0, RECENT_VISITS_MAX)))
  } catch {
    /* ignore */
  }
  bus.dispatchEvent(new Event(CHANGED))
}

/** 最近访问的 doc id（最近在前） */
export function getRecentVisitIds(): string[] {
  return readIds()
}

/** 打开文档时记录：置顶、去重、截断 */
export function recordVisit(docId: string): void {
  const id = docId.trim()
  if (!id) return
  const next = [id, ...readIds().filter((x) => x !== id)].slice(0, RECENT_VISITS_MAX)
  writeIds(next)
}

/** 文档删除后从足迹里摘掉（避免侧栏死链） */
export function removeVisit(docId: string): void {
  const id = docId.trim()
  if (!id) return
  const cur = readIds()
  if (!cur.includes(id)) return
  writeIds(cur.filter((x) => x !== id))
}

/**
 * 丢掉已不在可用文档集合里的足迹（软删 / 换库后的残留 id）。
 * 返回是否有变更。
 */
export function pruneVisitsNotIn(aliveIds: ReadonlySet<string>): boolean {
  const cur = readIds()
  const next = cur.filter((id) => aliveIds.has(id))
  if (next.length === cur.length) return false
  writeIds(next)
  return true
}

/** 按访问顺序排列文档；未出现在足迹里的丢弃 */
export function orderDocsByVisits<T extends { id: string }>(
  docs: readonly T[],
  visitIds: readonly string[],
): T[] {
  if (visitIds.length === 0 || docs.length === 0) return []
  const byId = new Map(docs.map((d) => [d.id, d]))
  const out: T[] = []
  for (const id of visitIds) {
    const d = byId.get(id)
    if (d) out.push(d)
  }
  return out
}

export function subscribeRecentVisits(listener: () => void): () => void {
  bus.addEventListener(CHANGED, listener)
  return () => bus.removeEventListener(CHANGED, listener)
}
