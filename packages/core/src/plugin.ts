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
