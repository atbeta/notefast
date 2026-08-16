/**
 * NoteFastEditor 的线格式共享类型。
 * M1 阶段仅声明骨架，供 shared / editor 两侧引用；M2 起由 NoteFastEditor 填充具体字段。
 */

/** 编辑器打开 / 预览的单个条目（文件或内存 Buffer） */
export interface PreviewItem {
  /** 显示标题（默认取文件名或 Markdown 首个 H1） */
  title: string
  /** Markdown 正文 */
  content: string
  /** 绝对路径（壳层文件关联传入；内存/无文件场景为空） */
  path?: string
}

/** NoteFastEditor 持久化的设置（壳层 Preferences 存储） */
export interface EditorSettings {
  /** 手动配置 / 自动发现的 NoteFast base URL（如 http://127.0.0.1:3140） */
  noteFastUrl: string
  /** Bearer token（空 = 免鉴权本地实例） */
  apiToken: string
}

/** 「导入到 NoteFast」的 HTTP 请求体（对齐 core importMarkdownSchema.source） */
export interface ImportPayload {
  markdown: string
  title?: string
  source: {
    provider: 'note-fast-editor'
    external_id: string
  }
}
