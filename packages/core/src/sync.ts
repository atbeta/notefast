/**
 * 数据同步适配器接口
 *
 * 设计原则：
 * - 数据主权：用户数据始终能用 Markdown 格式完整导出
 * - 适配器不绑定特定后端，实现该接口即可接入
 * - 生命周期钩子可在 sync 前后注入自定义逻辑
 */

export interface SyncInfo {
  /** 远端最后同步时间 */
  lastSyncAt?: string
  /** 远端文档数量（如能获取） */
  remoteDocCount?: number
  /** 适配器特定状态 */
  extra?: Record<string, unknown>
}

export interface SyncResult {
  /** 上传的文档数 */
  pushed: number
  /** 拉取的文档数（暂不实现双向同步，返回 0） */
  pulled: number
  /** 错误信息 */
  errors: string[]
}

export interface SyncAdapter {
  /** 适配器名称，如 's3' / 'git' / 'webdav' */
  readonly name: string

  /** 检查连接和远端状态 */
  info(): Promise<SyncInfo>

  /** 将本地变更推送到远端 */
  push(options?: PushOptions): Promise<SyncResult>

  /** 从远端拉取变更（预留，v0.1.0 仅实现单向导出） */
  pull?(options?: PullOptions): Promise<SyncResult>
}

export interface PushOptions {
  /** 仅导出 Markdown（不包含数据库文件） */
  markdownOnly?: boolean
  /** 导出的文档 ID 列表（不传则全部） */
  docIds?: string[]
  /** 目标路径前缀 */
  prefix?: string
}

export interface PullOptions {
  /** 拉取后是否覆盖本地已有文档 */
  overwrite?: boolean
  /** 来源路径前缀 */
  prefix?: string
}

/** 内建的适配器工厂签名 */
export type SyncAdapterFactory = (config: Record<string, string>) => SyncAdapter
