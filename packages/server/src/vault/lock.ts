/**
 * vault 串行锁：ingest / reconcile / writeback 都在 await 之间穿插 SQLite 事务，
 * 同一文档的两次处理若交错会让指纹对齐读到过期的旧子块。所有写路径都经这把锁排队。
 */

export type SerialLock = <T>(fn: () => Promise<T> | T) => Promise<T>

export function createSerialLock(): SerialLock {
  let tail: Promise<unknown> = Promise.resolve()
  return <T>(fn: () => Promise<T> | T): Promise<T> => {
    const run = tail.then(fn, fn)
    tail = run.catch(() => undefined)
    return run
  }
}
