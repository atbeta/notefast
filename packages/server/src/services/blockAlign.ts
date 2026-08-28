/**
 * 把旧子块序列与新 parse 结果对齐：精确指纹优先按文档序匹配，
 * 空隙里同类型块视为就地编辑（保留 id），其余为插入/删除。
 */

export type BlockAlignOp =
  | { kind: 'keep'; oldIndex: number; newIndex: number; contentChanged: boolean }
  | { kind: 'insert'; newIndex: number }
  | { kind: 'delete'; oldIndex: number }

export function fingerprintBlock(
  type: string,
  content: string,
  propertiesJson: string,
): string {
  return `${type}\n${content}\n${propertiesJson}`
}

/** 稳定序列化 properties，避免 key 顺序导致假 diff */
export function stablePropsJson(raw: string | Record<string, unknown> | undefined | null): string {
  let obj: Record<string, unknown> = {}
  if (typeof raw === 'string') {
    try {
      obj = JSON.parse(raw || '{}') as Record<string, unknown>
    } catch {
      obj = {}
    }
  } else if (raw && typeof raw === 'object') {
    obj = raw
  }
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(obj).sort()) {
    if (obj[key] !== undefined) out[key] = obj[key]
  }
  return JSON.stringify(out)
}

/**
 * old/new 等长指纹数组。匹配结果覆盖 0..old.length-1 与 0..new.length-1 各一次。
 */
export function planBlockAlign(
  oldFps: string[],
  newFps: string[],
  oldTypes: string[],
  newTypes: string[],
): BlockAlignOp[] {
  const usedOld = new Array(oldFps.length).fill(false)
  const usedNew = new Array(newFps.length).fill(false)
  const exact: Array<{ o: number; n: number }> = []

  const positions = new Map<string, number[]>()
  for (let n = 0; n < newFps.length; n++) {
    const fp = newFps[n]!
    const list = positions.get(fp)
    if (list) list.push(n)
    else positions.set(fp, [n])
  }
  const cursor = new Map<string, number>()
  let minN = 0
  for (let o = 0; o < oldFps.length; o++) {
    const fp = oldFps[o]!
    const list = positions.get(fp)
    if (!list) continue
    let k = cursor.get(fp) ?? 0
    while (k < list.length && list[k]! < minN) k++
    if (k >= list.length) continue
    const n = list[k]!
    exact.push({ o, n })
    usedOld[o] = true
    usedNew[n] = true
    cursor.set(fp, k + 1)
    minN = n + 1
  }

  const ops: BlockAlignOp[] = []
  let oi = 0
  let ni = 0

  const flushGap = (oEnd: number, nEnd: number) => {
    const dels: number[] = []
    const ins: number[] = []
    while (oi < oEnd) {
      if (!usedOld[oi]) dels.push(oi)
      oi++
    }
    while (ni < nEnd) {
      if (!usedNew[ni]) ins.push(ni)
      ni++
    }
    let d = 0
    let i = 0
    while (d < dels.length && i < ins.length) {
      if (oldTypes[dels[d]!] === newTypes[ins[i]!]) {
        ops.push({
          kind: 'keep',
          oldIndex: dels[d]!,
          newIndex: ins[i]!,
          contentChanged: oldFps[dels[d]!] !== newFps[ins[i]!],
        })
        d++
        i++
      } else {
        ops.push({ kind: 'delete', oldIndex: dels[d]! })
        d++
      }
    }
    while (d < dels.length) {
      ops.push({ kind: 'delete', oldIndex: dels[d]! })
      d++
    }
    while (i < ins.length) {
      ops.push({ kind: 'insert', newIndex: ins[i]! })
      i++
    }
  }

  for (const { o, n } of exact) {
    flushGap(o, n)
    ops.push({ kind: 'keep', oldIndex: o, newIndex: n, contentChanged: false })
    oi = o + 1
    ni = n + 1
  }
  flushGap(oldFps.length, newFps.length)
  return ops
}
