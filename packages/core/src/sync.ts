/**
 * 数据同步适配器接口
 *
 * 设计原则：
 * - 数据主权：用户数据始终能用 Markdown 格式完整导出
 * - 适配器不绑定特定后端，实现该接口即可接入
 * - 生命周期钩子可在 sync 前后注入自定义逻辑
 */

export type SyncAdapterKind = 'localfs' | 's3' | 'webdav'

export interface LocalFsAdapterConfig {
  kind: 'localfs'
  /** 导出目录；不存在会自动创建 */
  dir: string
  /** 文件名前缀（可选） */
  prefix?: string
  /** 启用 */
  enabled: boolean
}

export interface S3AdapterConfig {
  kind: 's3'
  /** 桶名 */
  bucket: string
  /** 区域 */
  region: string
  /** 自定义 endpoint（MinIO / R2 / 阿里云 OSS） */
  endpoint?: string
  /** 凭证 */
  accessKeyId: string
  secretAccessKey: string
  /** key 前缀 */
  prefix?: string
  /** MinIO 自建需要 true */
  forcePathStyle?: boolean
  enabled: boolean
}

export interface WebDavAdapterConfig {
  /** WebDAV 端点（绝对 URL） */
  kind: 'webdav'
  /** 例如：https://dav.example.com/remote.php/webdav 或 https://nas.local/dav/ */
  endpoint: string
  username: string
  password: string
  /** 远端路径前缀（可选），如 'notes' */
  prefix?: string
  /** 第一次推送时是否需要认证 challenge（Basic Auth 默认 true） */
  enabled: boolean
}

export type SyncAdapterConfig = LocalFsAdapterConfig | S3AdapterConfig | WebDavAdapterConfig

/** 持久化到磁盘的 sync 配置 */
export interface SyncPersistedConfig {
  version: 1
  active: SyncAdapterConfig | null
  /** 自动同步间隔（毫秒）；0 或 undefined 表示关闭 */
  autoSyncIntervalMs?: number
}

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
  /** 适配器名称，如 'localfs' / 's3' / 'webdav' */
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

export function emptySyncConfig(): SyncPersistedConfig {
  return { version: 1, active: null }
}

/** 对外展示时移除密钥 */
export function publicSyncView(cfg: SyncPersistedConfig): SyncPersistedConfig {
  if (!cfg.active) return cfg
  if (cfg.active.kind === 's3') {
    return {
      ...cfg,
      active: {
        ...cfg.active,
        accessKeyId: cfg.active.accessKeyId ? '***set***' : '',
        secretAccessKey: cfg.active.secretAccessKey ? '***set***' : '',
      },
    }
  }
  if (cfg.active.kind === 'webdav') {
    return {
      ...cfg,
      active: {
        ...cfg.active,
        username: cfg.active.username ? '***set***' : '',
        password: cfg.active.password ? '***set***' : '',
      },
    }
  }
  return cfg
}
