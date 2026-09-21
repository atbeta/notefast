/**
 * 文档阅读态文内查找：纯偏移计算，不碰 DOM。
 * 高亮由 DocFindBar 用 Range + CSS Custom Highlight 画（不插 DOM 节点，
 * 所以查找不会污染块数据、也不会把文档判成「未保存」）。
 *
 * **这里是查找的唯一匹配实现**：计数、高亮、上一处/下一处都走它。
 * 之前计数用 `indexOf`、高亮各扫各的，一旦加上「区分大小写 / 全词 / 正则」
 * 这类开关，两边的边界行为必然慢慢走偏，最后表现为「计数说 3 处、高亮只标了 2 处」
 * 这种谁也说不清的问题（lector findMatch.ts 头注释记着同一条教训）。
 *
 * 两个安全取舍：
 *
 * 1. **灾难性回溯**：`(a+)+$` 这类形状能在几十个字符的输入上把主线程卡死几十秒。
 *    JS 正则同步执行、没有超时机制，唯一的兜底是在编译期拦掉已知的危险形状
 *    （嵌套量词）并给命中数设上限。这是启发式、会有误伤（如 `(ab{2})+` 其实安全），
 *    但宁可提示一句「正则过于复杂」让用户改写，也不要赌主线程不卡死。
 * 2. **全词匹配对中文无意义**：`\b` 是「单词边界」，而中文没有空格分词，
 *    「全词」对中文文本等于「整段相等」。所以不装作支持——UI 上把这一点写清楚。
 */

export interface FindRange {
  start: number
  end: number
}

export interface FindOptions {
  /** 区分大小写 */
  caseSensitive: boolean
  /** 全词匹配（仅西文有意义，见文件头） */
  wholeWord: boolean
  /** 按正则解释查询串 */
  regex: boolean
}

export const DEFAULT_FIND_OPTIONS: FindOptions = {
  caseSensitive: false,
  wholeWord: false,
  regex: false,
}

export type FindError = 'empty' | 'invalid-regex' | 'risky-regex'

/** 命中上限：查找面板不需要报「一万处」，但用户可能在一个大文档里搜常见字。 */
export const MAX_MATCHES = 5000

/** 模式串长度上限：正常查询不会这么长，超了基本是误粘。 */
export const MAX_PATTERN = 200

/**
 * 嵌套量词：`(a+)+`、`(\w*)*`、`(\d{1,3})+`——灾难性回溯最经典的形状。
 * 量词包括 `+ * ?` 与 `{n}` / `{n,}` / `{n,m}`；漏掉花括号那一支是实测出来的
 * （`(\d{1,3})+` 当时被判成安全）。
 */
const NESTED_QUANTIFIER = /\([^()]*(?:[+*?]|\{\d+,?\d*\})[^()]*\)\s*(?:[+*?]|\{\d+,?\d*\})/

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export type CompiledFind =
  | { ok: true; find: (text: string) => FindRange[]; source: string; flags: string }
  | { ok: false; error: FindError }

/**
 * 编译查询。返回的 `find` 在一段文本里给出所有命中（按位置升序、不重叠）。
 *
 * 无效查询**不回退成字符串搜**——那会让用户以为正则生效了。
 * 字面量模式沿用「两端空白自动去掉」的既有手感；正则模式不去（`^` 与结尾空格
 * 是用户有意写的）。
 */
export function compileFind(query: string, opts: FindOptions = DEFAULT_FIND_OPTIONS): CompiledFind {
  const raw = opts.regex ? query : query.trim()
  if (raw.length === 0) return { ok: false, error: 'empty' }
  if (raw.length > MAX_PATTERN) return { ok: false, error: 'risky-regex' }

  let source: string
  if (opts.regex) {
    if (NESTED_QUANTIFIER.test(raw)) return { ok: false, error: 'risky-regex' }
    source = raw
  } else {
    source = escapeRegExp(raw)
    // 全词只对西文成立，且正则模式下不再叠加（用户自己在模式里写边界更可控）
    if (opts.wholeWord) source = `\\b${source}\\b`
  }

  let re: RegExp
  try {
    re = new RegExp(source, opts.caseSensitive ? 'g' : 'gi')
  } catch {
    return { ok: false, error: 'invalid-regex' }
  }

  return {
    ok: true,
    source,
    flags: re.flags,
    find: (text: string): FindRange[] => {
      const out: FindRange[] = []
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(text)) !== null) {
        // 零宽命中（如 a* 在无 a 处）：不推进就会死循环
        if (m[0].length === 0) {
          re.lastIndex += 1
          continue
        }
        out.push({ start: m.index, end: m.index + m[0].length })
        if (out.length >= MAX_MATCHES) break
      }
      return out
    },
  }
}

/** 命中数（不想自己编译的调用方用这个）。 */
export function countMatches(text: string, query: string, opts: FindOptions = DEFAULT_FIND_OPTIONS): number {
  const c = compileFind(query, opts)
  return c.ok ? c.find(text).length : 0
}

/**
 * 兼容入口：默认选项（大小写不敏感的子串查找）。
 * 空查询无命中。
 *
 * 命中**不重叠**（`Ababa` 里搜 `aba` 只算 1 处）。旧实现按「上次起点 +1」推进，
 * 会把同一段文字算成 2 处；而高亮是按区间画的（并集），于是计数 2、屏幕上却只有
 * 一处亮着——这正是「计数与高亮对不上」的典型来源，也让「下一处」在原地打转。
 */
export function findMatchRanges(haystack: string, query: string): FindRange[] {
  const c = compileFind(query, DEFAULT_FIND_OPTIONS)
  return c.ok ? c.find(haystack) : []
}

/** current=-1 表示尚未选中；dir=1 下一个，-1 上一个。count=0 时保持 -1。 */
export function stepFindIndex(current: number, count: number, dir: 1 | -1): number {
  if (count <= 0) return -1
  if (current < 0) return dir === 1 ? 0 : count - 1
  return (current + dir + count) % count
}

export const DOC_FIND_EVENT = 'nf:find'
export const DOC_FIND_NEXT_EVENT = 'nf:find-next'
export const DOC_FIND_PREV_EVENT = 'nf:find-prev'
