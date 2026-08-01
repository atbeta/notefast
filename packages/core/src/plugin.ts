/**
 * 生命周期钩子系统
 *
 * 设计原则：
 * - 核心负责 90% 功能，钩子负责 10% 社区扩展
 * - 不是「靠插件补功能」，而是「核心完整 + 插件锦上添花」
 * - 每个钩子有明确的参数类型和返回值契约
 * - 当前仅定义钩子接口，不加载外部插件代码
 */

// ─────────────────────────── Hook 类型 ───────────────────────────

type TapFn<T extends unknown[]> = (...args: T) => void | Promise<void>

interface TapEntry<T extends unknown[]> {
  name: string
  fn: TapFn<T>
}

export class SyncHook<T extends unknown[] = []> {
  private taps: TapEntry<T>[] = []

  tap(name: string, fn: TapFn<T>): void {
    this.taps.push({ name, fn })
  }

  /** 移除指定 name 的所有 tap（用于热重载） */
  untap(name: string): void {
    this.taps = this.taps.filter((t) => t.name !== name)
  }

  call(...args: T): void {
    for (const entry of this.taps) {
      entry.fn(...args)
    }
  }
}

export class AsyncParallelHook<T extends unknown[] = []> {
  private taps: TapEntry<T>[] = []

  tap(name: string, fn: TapFn<T>): void {
    this.taps.push({ name, fn })
  }

  /** 移除指定 name 的所有 tap（用于热重载） */
  untap(name: string): void {
    this.taps = this.taps.filter((t) => t.name !== name)
  }

  async call(...args: T): Promise<void> {
    await Promise.all(this.taps.map((entry) => entry.fn(...args)))
  }
}

/** 返回值非 undefined 时中断后续执行 */
export class SyncBailHook<T extends unknown[] = [], R = unknown> {
  private taps: { name: string; fn: (...args: T) => R | undefined }[] = []

  tap(name: string, fn: (...args: T) => R | undefined): void {
    this.taps.push({ name, fn })
  }

  /** 移除指定 name 的所有 tap */
  untap(name: string): void {
    this.taps = this.taps.filter((t) => t.name !== name)
  }

  call(...args: T): R | undefined {
    for (const entry of this.taps) {
      const result = entry.fn(...args)
      if (result !== undefined) return result
    }
    return undefined
  }
}

/** 前一个返回值作为后一个的输入 */
export class SyncWaterfallHook<T> {
  private taps: { name: string; fn: (val: T) => T }[] = []

  tap(name: string, fn: (val: T) => T): void {
    this.taps.push({ name, fn })
  }

  call(initial: T): T {
    let value = initial
    for (const entry of this.taps) {
      value = entry.fn(value)
    }
    return value
  }
}

// ─────────────────────────── 生命周期组 ───────────────────────────

import type { Block, CreateBlockInput, UpdateBlockInput, SearchResult, HeadingNode } from './types'

export interface NoteLifecycle {
  beforeCreate: SyncBailHook<[CreateBlockInput], CreateBlockInput>
  afterCreate: AsyncParallelHook<[Block]>
  beforeUpdate: SyncBailHook<[blockId: string, input: UpdateBlockInput], UpdateBlockInput>
  afterUpdate: AsyncParallelHook<[Block]>
  beforeDelete: SyncBailHook<[blockId: string], boolean>
  afterDelete: AsyncParallelHook<[blockId: string]>
}

/** 文档级生命周期事件的统一载荷：目标文档 + 操作上下文 */
export interface DocumentEventPayload {
  /** 文档根 block（type='document'） */
  doc: Block
  /** 变更前状态（afterStatusChange / afterTagChange 提供；其它可缺省） */
  before?: { status?: string; tags?: string[] }
  /** 操作附加信息（如分享 token / 新状态 / 来源渠道） */
  meta?: Record<string, unknown>
}

/**
 * 文档级生命周期钩子（区别于 NoteLifecycle 的 block 粒度）：
 * 文档是第三方最自然的扩展挂点（归档/分享/标签/删除/创建），
 * 粒度对齐「一个文档一个动作」，避免扩展者监听一堆 block 事件再自行聚合。
 */
export interface DocumentLifecycle {
  /** 文档创建完成（含导入入库） */
  afterCreate: AsyncParallelHook<[DocumentEventPayload]>
  /** 文档状态变更（归档 / 升格 / 进收集箱）；payload.before.status 为旧状态 */
  afterStatusChange: AsyncParallelHook<[DocumentEventPayload]>
  /** 打标签完成；payload.before.tags 为旧标签，meta 含新增/删除集合 */
  afterTagChange: AsyncParallelHook<[DocumentEventPayload]>
  /** 公开分享开启；meta 含 token / path / expires_at */
  afterShare: AsyncParallelHook<[DocumentEventPayload]>
  /** 公开分享关闭；meta 含旧 token（若有关闭前的记录） */
  afterShareRevoked: AsyncParallelHook<[DocumentEventPayload]>
  /** 文档软删除完成 */
  afterDelete: AsyncParallelHook<[DocumentEventPayload]>
}

export interface RenderLifecycle {
  beforeRenderBlock: SyncWaterfallHook<Block>
  afterRenderBlock: SyncHook<[Block]>
  headingTreeBuild: SyncWaterfallHook<HeadingNode[]>
}

export interface SearchLifecycle {
  beforeSearch: SyncWaterfallHook<{ query: string; limit: number }>
  afterSearch: SyncWaterfallHook<SearchResult[]>
}

export interface UILifecycle {
  sidebarItems: SyncHook<[Array<{ id: string; label: string; icon?: string; action: () => void }>]>
  commands: SyncHook<[Array<{ id: string; label: string; shortcut?: string; action: () => void }>]>
}

export interface IOLifecycle {
  beforeImport: SyncWaterfallHook<{ markdown: string; title?: string }>
  afterImport: AsyncParallelHook<[docId: string]>
  beforeExport: SyncWaterfallHook<Block>
}

// ─────────────────────────── 插件系统入口 ───────────────────────────

export interface PluginContext {
  readonly hooks: PluginSystem
}

export interface Plugin {
  name: string
  apply(ctx: PluginContext): void | Promise<void>
}

export interface PluginSystem {
  note: NoteLifecycle
  doc: DocumentLifecycle
  render: RenderLifecycle
  search: SearchLifecycle
  ui: UILifecycle
  io: IOLifecycle
  register(plugin: Plugin): Promise<void>
}

export function createPluginSystem(): PluginSystem {
  const plugins: Plugin[] = []

  const system: PluginSystem = {
    note: {
      beforeCreate: new SyncBailHook(),
      afterCreate: new AsyncParallelHook(),
      beforeUpdate: new SyncBailHook(),
      afterUpdate: new AsyncParallelHook(),
      beforeDelete: new SyncBailHook(),
      afterDelete: new AsyncParallelHook(),
    },
    doc: {
      afterCreate: new AsyncParallelHook(),
      afterStatusChange: new AsyncParallelHook(),
      afterTagChange: new AsyncParallelHook(),
      afterShare: new AsyncParallelHook(),
      afterShareRevoked: new AsyncParallelHook(),
      afterDelete: new AsyncParallelHook(),
    },
    render: {
      beforeRenderBlock: new SyncWaterfallHook(),
      afterRenderBlock: new SyncHook(),
      headingTreeBuild: new SyncWaterfallHook<HeadingNode[]>(),
    },
    search: {
      beforeSearch: new SyncWaterfallHook(),
      afterSearch: new SyncWaterfallHook<SearchResult[]>(),
    },
    ui: {
      sidebarItems: new SyncHook(),
      commands: new SyncHook(),
    },
    io: {
      beforeImport: new SyncWaterfallHook(),
      afterImport: new AsyncParallelHook(),
      beforeExport: new SyncWaterfallHook<Block>(),
    },

    async register(plugin: Plugin): Promise<void> {
      plugins.push(plugin)
      await plugin.apply({ hooks: system })
    },
  }

  return system
}
