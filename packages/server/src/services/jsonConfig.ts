/**
 * JSON 配置持久化统一骨架（原六处手写 load/save/chmod 样板：backup /
 * sync protocol / Markdown 归档 / 图床上传 / 存储连接 / preferences）。
 *
 * 约定：文件在 dataDir 下，600 权限；损坏/无效回退 empty 配置；测试钩子
 * _resetForTests 清 dataDir 与内存态。
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface JsonConfigStore<T> {
  /** 绑定数据目录并从磁盘加载；无文件/损坏 → empty */
  init(dir: string): T
  get(): T
  /** 覆盖写（内存 + 磁盘，600 权限） */
  set(next: T): void
  /** init 后有效：磁盘文件是否存在（区分「首次启动」与「已持久化」） */
  exists(): boolean
  /** 测试钩子 */
  _resetForTests(): void
}

export interface JsonConfigStoreOptions<T> {
  fileName: string
  empty: () => T
  /** 磁盘原始 JSON → 配置；返回 null = 无效（回退 empty 但 exists 仍为 true 语义由调用方决定） */
  parse?: (raw: unknown) => T | null
  /** 未 init 时 set 的行为（默认抛错；静默场景用 'ignore'） */
  uninitializedSet?: 'throw' | 'ignore'
}

export function createJsonConfigStore<T>(opts: JsonConfigStoreOptions<T>): JsonConfigStore<T> {
  let dataDir = ''
  let cfg = opts.empty()
  let fileExisted = false
  const path = (): string => join(dataDir, opts.fileName)

  function init(dir: string): T {
    dataDir = dir
    fileExisted = false
    cfg = opts.empty()
    if (!dataDir || !existsSync(path())) return cfg
    fileExisted = true
    try {
      const raw = JSON.parse(readFileSync(path(), 'utf-8')) as unknown
      const parsed = opts.parse ? opts.parse(raw) : (raw as T)
      if (parsed !== null && parsed !== undefined) cfg = parsed
    } catch {
      /* 损坏回退 empty */
    }
    return cfg
  }

  function set(next: T): void {
    cfg = next
    if (!dataDir) {
      if (opts.uninitializedSet === 'ignore') return
      throw new Error(`${opts.fileName}: dataDir 未初始化`)
    }
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true })
    writeFileSync(path(), JSON.stringify(next, null, 2) + '\n', 'utf-8')
    try { chmodSync(path(), 0o600) } catch { /* Windows 等环境可能不支持 chmod */ }
  }

  function _resetForTests(): void {
    dataDir = ''
    cfg = opts.empty()
    fileExisted = false
  }

  return {
    init,
    get: () => cfg,
    set,
    exists: () => fileExisted,
    _resetForTests,
  }
}
