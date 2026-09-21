/**
 * 文档阅读位置：重新打开（含关掉浏览器/壳之后再回来）回到上次读到的地方。
 *
 * 这是阅读器的刚需，不是锦上添花：一篇长文档关掉再打开就回到顶部，
 * 等于每次都要重新找位置。三条设计取舍（与 lector readingPosition.ts 同源）：
 *
 * 1. **存「滚动偏移 + 文档长度」，不存百分比**。文档被编辑变长后，按比例恢复会把
 *    位置算错，按绝对偏移至少落在同一段附近；长度只用来做一次合理性判断
 *    （文档被删掉一半以上时旧偏移多半已落到别处，就不恢复）。
 * 2. **写入防抖 400ms**。滚动时每个 scroll 事件同步写 localStorage 会拖慢滚动，
 *    而这个值只需要在「用户停下来」时准确。切文档/卸载走 flush，不留悬挂写。
 * 3. **回到顶部 = 主动放弃记录**（`top < MIN_RECORDED_TOP` 就删掉旧值），
 *    否则下次打开会莫名其妙跳回中间。
 *
 * 用 localStorage 而不是 sessionStorage：关标签页/关壳就丢，等于没有记忆——
 * 而「隔天接着读」正是这个功能存在的理由。这是**本机阅读足迹**，不进服务端、
 * 不进备份、不参与多端同步（与 lib/recentVisits.ts 同一原则）。
 *
 * 存取逻辑抽成纯函数：这类「键值累积 + 淘汰」的代码最容易长成一个只会增长的
 * localStorage，而它出问题没有任何报错。
 */

/** 单条记录。`len` 是记录位置时的**文档内容长度**，用于判断旧位置是否还有效。 */
export interface DocScrollRecord {
  /** 滚动偏移（px） */
  top: number
  /**
   * 记录时的文档内容长度（上屏字符数，见 lib/docStats.ts）。
   *
   * 用内容长度而不是滚动高度（scrollHeight）：高度受图片 / mermaid 异步渲染影响，
   * 恢复时它们往往还没画完，高度会偏小，于是「文档变短了」的误判会把
   * 明明有效的阅读位置丢掉。内容长度不受渲染时机影响。
   */
  len: number
  /** 记录时间戳，淘汰最旧用 */
  at: number
}

export type DocScrollMap = Record<string, DocScrollRecord>

/** 单一 blob 键（与 recentVisits 同一布局：条目少、需要整体淘汰，逐 doc 键反而难清理）。 */
export const DOC_SCROLLS_KEY = 'nf:doc-scrolls'

/** 最多记多少篇文档的位置。超出后淘汰最久未读的。 */
export const MAX_DOC_SCROLLS = 60

/** 比这更靠上的位置不记：刚打开就关掉的文件不值得占一个槽位。 */
export const MIN_RECORDED_TOP = 40

/** 写入防抖：滚动停下来 400ms 才落盘。 */
export const SCROLL_WRITE_DEBOUNCE_MS = 400

/**
 * 记录一个位置，返回新的 map（不修改入参）。
 *
 * `top < MIN_RECORDED_TOP` 视为「读者主动回到顶部」：删掉旧记录，
 * 而不是记一条 top≈0——否则下次打开会又跳回中间。
 */
export function recordDocScroll(
  map: DocScrollMap,
  docId: string,
  top: number,
  len: number,
  now = Date.now(),
): DocScrollMap {
  const id = docId.trim()
  if (!id) return map
  if (!Number.isFinite(top) || top < MIN_RECORDED_TOP) {
    if (!(id in map)) return map
    const next = { ...map }
    delete next[id]
    return next
  }
  return { ...map, [id]: { top: Math.round(top), len: Math.max(0, Math.round(len)), at: now } }
}

/**
 * 取某篇文档该恢复到的位置；没有记录、或旧位置明显失效时返回 null。
 *
 * 失效判据：当前内容长度不足记录时的 50%——文档被大幅改写（删掉一半以上）时，
 * 旧偏移多半已经落到别处，恢复过去反而添乱。
 */
export function docScrollTop(map: DocScrollMap, docId: string, currentLen: number): number | null {
  const rec = map[docId.trim()]
  if (!rec) return null
  if (rec.top < MIN_RECORDED_TOP) return null
  if (rec.len > 0 && currentLen > 0 && currentLen < rec.len * 0.5) return null
  return rec.top
}

/** 淘汰到上限之内，保留最近读过的。 */
export function pruneDocScrolls(map: DocScrollMap, max = MAX_DOC_SCROLLS): DocScrollMap {
  const keys = Object.keys(map)
  if (keys.length <= max) return map
  const keep = keys.sort((a, b) => (map[b]?.at ?? 0) - (map[a]?.at ?? 0)).slice(0, max)
  const next: DocScrollMap = {}
  for (const k of keep) {
    const v = map[k]
    if (v) next[k] = v
  }
  return next
}

/** 解析存储里的原始字符串，坏数据一律当空（逐字段校验，不整条吞）。 */
export function parseDocScrolls(raw: string | null): DocScrollMap {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: DocScrollMap = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (!v || typeof v !== 'object') continue
      const rec = v as Partial<DocScrollRecord>
      if (typeof rec.top !== 'number' || !Number.isFinite(rec.top)) continue
      out[k] = {
        top: rec.top,
        len: typeof rec.len === 'number' && Number.isFinite(rec.len) ? rec.len : 0,
        at: typeof rec.at === 'number' && Number.isFinite(rec.at) ? rec.at : 0,
      }
    }
    return out
  } catch {
    return {}
  }
}

// ───────────────────────── 存储与防抖（模块级单例） ─────────────────────────

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    /* 隐私模式等：当作没有存储 */
    return null
  }
}

function loadAll(): DocScrollMap {
  const store = storage()
  if (!store) return {}
  try {
    return parseDocScrolls(store.getItem(DOC_SCROLLS_KEY))
  } catch {
    return {}
  }
}

function saveAll(map: DocScrollMap): void {
  const store = storage()
  if (!store) return
  try {
    store.setItem(DOC_SCROLLS_KEY, JSON.stringify(pruneDocScrolls(map)))
  } catch {
    /* 配额/隐私模式：位置记忆丢了不影响正确性 */
  }
}

/** 读取某篇文档上次的阅读位置（无记录或已失效返回 null）。 */
export function readDocScrollTop(docId: string, currentLen: number): number | null {
  return docScrollTop(loadAll(), docId, currentLen)
}

/** 待落盘的一条记录（防抖窗口内）。 */
let pending: { id: string; top: number; len: number } | null = null
let pendingTimer: ReturnType<typeof setTimeout> | null = null

/** 记下当前位置（防抖）。滚动热路径只调它，不碰 localStorage。 */
export function scheduleDocScrollWrite(docId: string, top: number, len: number): void {
  if (!docId) return
  pending = { id: docId, top, len }
  if (pendingTimer !== null) clearTimeout(pendingTimer)
  pendingTimer = setTimeout(() => {
    pendingTimer = null
    flushDocScrollWrite()
  }, SCROLL_WRITE_DEBOUNCE_MS)
}

/** 立即落盘待写记录（切文档 / 卸载时用）。无悬挂写则什么都不做。 */
export function flushDocScrollWrite(): void {
  if (pendingTimer !== null) {
    clearTimeout(pendingTimer)
    pendingTimer = null
  }
  const item = pending
  pending = null
  if (!item) return
  saveAll(recordDocScroll(loadAll(), item.id, item.top, item.len))
}
