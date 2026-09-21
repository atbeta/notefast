/**
 * 极简 LRU 缓存（Map 的插入序就是 LRU 序）。
 *
 * 为什么自己写而不是引库：用到的只有「读一次、命中挪到队尾、超限丢队首」三件事，
 * 依赖一个库来换这二十行不划算（lector mermaid.ts 的同一取舍）。
 *
 * 为什么需要它：mermaid / KaTeX 这类渲染很贵（几十毫秒一张图），而同样的内容
 * 会被反复渲染——主题来回切换、块重挂载、滚动离开再回来。缓存之后只有第一次真渲染。
 *
 * 注意：**失败结果不要塞进来**。一次失败（例如动态 import 拿到 504）若被记住，
 * 会把整个会话钉死——之后每次重试都拿到同一个已 reject 的 promise。
 */
export interface LruCache<K, V> {
  get(key: K): V | null
  set(key: K, value: V): void
  delete(key: K): void
  clear(): void
  readonly size: number
  /** 当前顺序（队首最旧）——测试与调试用。 */
  keys(): K[]
}

export function createLruCache<K, V>(max: number): LruCache<K, V> {
  const limit = Math.max(1, Math.floor(max))
  const map = new Map<K, V>()
  return {
    get(key) {
      if (!map.has(key)) return null
      const value = map.get(key)!
      // 命中即刷新新鲜度：不重插的话就成了 FIFO，常用的反而先被淘汰
      map.delete(key)
      map.set(key, value)
      return value
    },
    set(key, value) {
      map.delete(key)
      map.set(key, value)
      while (map.size > limit) {
        const oldest = map.keys().next().value
        if (oldest === undefined) break
        map.delete(oldest)
      }
    },
    delete(key) {
      map.delete(key)
    },
    clear() {
      map.clear()
    },
    get size() {
      return map.size
    },
    keys() {
      return [...map.keys()]
    },
  }
}
