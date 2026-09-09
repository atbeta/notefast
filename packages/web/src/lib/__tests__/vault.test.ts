import { describe, test, expect } from 'bun:test'
import type { StorageLocation } from '@notefast/core'
import {
  isVaultAssetName,
  isVaultEnabled,
  parseSyncIntervalSeconds,
  recentConflictPaths,
  reconcileErrorCount,
  resolveVaultAssetSrc,
  resolveVaultEmbedSrc,
  syncConfigPayload,
  syncConflictCount,
  syncConfigured,
  syncEnabled,
  syncFormFromStatus,
  syncLocalDirOf,
  syncServiceRunning,
  syncStatusOf,
  syncTargetLabel,
  syncTargetLocationId,
  vaultPathOf,
  type VaultStatus,
  type VaultSyncStatus,
} from '../vault'

const ENABLED: VaultStatus = {
  enabled: true,
  root: '/v',
  conflicts: { count: 3, paths: ['a.md', 'b.md'] },
  last_reconcile: {
    totalFiles: 1,
    created: 0,
    updated: 0,
    unchanged: 1,
    restored: 0,
    moved: 0,
    deleted: 0,
    errors: [{ relPath: 'x.md', error: 'boom' }],
    durationMs: 5,
  },
}

describe('isVaultEnabled', () => {
  test('enabled: true → 显示入口', () => {
    expect(isVaultEnabled(ENABLED)).toBe(true)
  })

  test('enabled: false → 隐藏入口', () => {
    expect(isVaultEnabled({ enabled: false })).toBe(false)
  })

  test('null / undefined（加载中、请求失败）→ 隐藏入口', () => {
    expect(isVaultEnabled(null)).toBe(false)
    expect(isVaultEnabled(undefined)).toBe(false)
  })
})

describe('recentConflictPaths', () => {
  test('返回服务端给的冲突副本路径', () => {
    expect(recentConflictPaths(ENABLED)).toEqual(['a.md', 'b.md'])
  })

  test('缺字段 / 超上限 → 安全兜底', () => {
    expect(recentConflictPaths({ enabled: true })).toEqual([])
    expect(recentConflictPaths(null)).toEqual([])
    const many = { enabled: true, conflicts: { count: 20, paths: Array.from({ length: 20 }, (_, i) => `${i}.md`) } }
    expect(recentConflictPaths(many, 3)).toHaveLength(3)
  })
})

describe('reconcileErrorCount', () => {
  test('有错误 → 条数', () => {
    expect(reconcileErrorCount(ENABLED)).toBe(1)
  })

  test('没有 last_reconcile → 0', () => {
    expect(reconcileErrorCount({ enabled: true })).toBe(0)
    expect(reconcileErrorCount(null)).toBe(0)
  })
})

// ───────────────────── 文件同步（RFC 0004 P3） ─────────────────────

const SYNC: VaultSyncStatus = {
  enabled: true,
  configured: true,
  target: 's3://notefast-bucket/notefast-vault-sync/',
  prefix: 'notefast-vault-sync/',
  interval_seconds: 120,
  vault_id: 'vault-1',
  device_id: 'device-1',
  last_push_at: '2030-01-02T03:04:05.000Z',
  last_pull_at: null,
  last_error: null,
  last_push: { scanned: 12, changed: 3, uploaded_blobs: 2, tombstones: 1, touched_only: 4 },
  last_pull: {
    remote_entries: 9,
    applied: 2,
    deleted: 0,
    unchanged: 7,
    conflicts: ['a.md', 'b.md'],
    errors: [],
  },
  tracked_files: 11,
  next_run_at: null,
  running: true,
}

const LOCATIONS: StorageLocation[] = [
  {
    id: 'loc-s3',
    name: 'bucket',
    kind: 's3',
    s3: { bucket: 'notefast-bucket', region: 'us-east-1', accessKeyId: 'k', secretAccessKey: 's' },
  },
  {
    id: 'loc-s3-deep',
    name: 'nested',
    kind: 's3',
    s3: { bucket: 'notefast-bucket', region: 'us-east-1', accessKeyId: 'k', secretAccessKey: 's' },
  },
  {
    id: 'loc-webdav',
    name: 'dav',
    kind: 'webdav',
    webdav: { endpoint: 'https://dav.example.com/remote.php/dav', username: 'u', password: 'p' },
  },
]

const withSync = (sync?: VaultSyncStatus): VaultStatus => ({ enabled: true, root: '/v', sync })

describe('syncStatusOf / syncConfigured / syncEnabled / syncServiceRunning', () => {
  test('有 sync 块 → 原样返回', () => {
    expect(syncStatusOf(withSync(SYNC))).toEqual(SYNC)
  })

  test('旧服务端 / null → null 与安全兜底 false', () => {
    expect(syncStatusOf(withSync())).toBeNull()
    expect(syncStatusOf(null)).toBeNull()
    expect(syncConfigured(withSync())).toBe(false)
    expect(syncEnabled(null)).toBe(false)
    expect(syncServiceRunning(null)).toBe(false)
  })

  test('configured / enabled / running 各自独立', () => {
    const s = { ...SYNC, configured: false, enabled: false, running: false }
    expect(syncConfigured(withSync(s))).toBe(false)
    expect(syncEnabled(withSync(s))).toBe(false)
    expect(syncServiceRunning(withSync(s))).toBe(false)
    expect(syncConfigured(withSync(SYNC))).toBe(true)
    expect(syncEnabled(withSync(SYNC))).toBe(true)
    expect(syncServiceRunning(withSync(SYNC))).toBe(true)
  })
})

describe('syncConflictCount / syncTargetLabel / syncLocalDirOf', () => {
  test('冲突副本数来自 last_pull.conflicts', () => {
    expect(syncConflictCount(withSync(SYNC))).toBe(2)
    expect(syncConflictCount(withSync({ ...SYNC, last_pull: null }))).toBe(0)
    expect(syncConflictCount(null)).toBe(0)
  })

  test('target 为空 / 缺省 → null', () => {
    expect(syncTargetLabel(withSync(SYNC))).toBe('s3://notefast-bucket/notefast-vault-sync/')
    expect(syncTargetLabel(withSync({ ...SYNC, target: null }))).toBeNull()
    expect(syncTargetLabel(withSync({ ...SYNC, target: '  ' }))).toBeNull()
    expect(syncTargetLabel(null)).toBeNull()
  })

  test('LocalFS 目标反解本地目录', () => {
    expect(syncLocalDirOf(withSync({ ...SYNC, target: 'local:/tmp/nf-sync' }))).toBe('/tmp/nf-sync')
    expect(syncLocalDirOf(withSync(SYNC))).toBe('')
    expect(syncLocalDirOf(null)).toBe('')
  })
})

describe('syncTargetLocationId', () => {
  test('S3 目标按 bucket 反查连接 id', () => {
    expect(syncTargetLocationId(withSync(SYNC), [LOCATIONS[2]!, LOCATIONS[0]!])).toBe('loc-s3')
  })

  test('WebDAV 目标按 endpoint 反查连接 id', () => {
    const s = { ...SYNC, target: 'webdav:https://dav.example.com/remote.php/dav/sync/' }
    expect(syncTargetLocationId(withSync(s), LOCATIONS)).toBe('loc-webdav')
  })

  test('LocalFS / 未配置 / 连接已删除 → 空串', () => {
    expect(syncTargetLocationId(withSync({ ...SYNC, target: 'local:/tmp/x' }), LOCATIONS)).toBe('')
    expect(syncTargetLocationId(withSync(SYNC), [])).toBe('')
    expect(syncTargetLocationId(null, LOCATIONS)).toBe('')
  })
})

describe('syncFormFromStatus', () => {
  test('已配置 → 回填开关 / 连接 / 前缀（去掉尾斜杠）/ 间隔', () => {
    expect(syncFormFromStatus(withSync(SYNC), LOCATIONS)).toEqual({
      enabled: true,
      locationId: 'loc-s3',
      localDir: '',
      prefix: 'notefast-vault-sync',
      intervalSeconds: '120',
    })
  })

  test('LocalFS 目标 → 回填本地目录且不带连接', () => {
    const s = { ...SYNC, target: 'local:/tmp/nf-sync', prefix: '' }
    expect(syncFormFromStatus(withSync(s), LOCATIONS)).toEqual({
      enabled: true,
      locationId: '',
      localDir: '/tmp/nf-sync',
      prefix: '',
      intervalSeconds: '120',
    })
  })

  test('未配置 / 无 sync 块 → 空表单 + 60 秒兜底', () => {
    const empty = {
      enabled: false,
      locationId: '',
      localDir: '',
      prefix: '',
      intervalSeconds: '60',
    }
    expect(syncFormFromStatus(withSync())).toEqual(empty)
    expect(syncFormFromStatus(null)).toEqual(empty)
    expect(syncFormFromStatus(withSync({ ...SYNC, enabled: false, interval_seconds: 0 }))).toEqual({
      ...empty,
      prefix: 'notefast-vault-sync',
      intervalSeconds: '0',
    })
  })
})

describe('parseSyncIntervalSeconds / syncConfigPayload', () => {
  test('空 / 非法 / 负数 / 小数 → 0 或取整', () => {
    expect(parseSyncIntervalSeconds('')).toBe(0)
    expect(parseSyncIntervalSeconds('  ')).toBe(0)
    expect(parseSyncIntervalSeconds('abc')).toBe(0)
    expect(parseSyncIntervalSeconds('-5')).toBe(0)
    expect(parseSyncIntervalSeconds('90.4')).toBe(90)
    expect(parseSyncIntervalSeconds(' 60 ')).toBe(60)
  })

  test('表单 → PUT 入参：空连接为 null，字符串去空白', () => {
    expect(
      syncConfigPayload({
        enabled: true,
        locationId: '  ',
        localDir: ' /tmp/nf-sync ',
        prefix: ' sync ',
        intervalSeconds: '',
      }),
    ).toEqual({
      enabled: true,
      locationId: null,
      localDir: '/tmp/nf-sync',
      prefix: 'sync',
      intervalSeconds: 0,
    })
    expect(
      syncConfigPayload({
        enabled: false,
        locationId: 'loc-s3',
        localDir: '',
        prefix: '',
        intervalSeconds: '120',
      }),
    ).toEqual({
      enabled: false,
      locationId: 'loc-s3',
      localDir: '',
      prefix: '',
      intervalSeconds: 120,
    })
  })
})

describe('vaultPathOf', () => {
  test('vault 文档带 vault_path → 返回路径', () => {
    expect(vaultPathOf({ id: 'd1', vault_path: 'notes/a.md' })).toBe('notes/a.md')
  })

  test('db notebook 无该字段 → null', () => {
    expect(vaultPathOf({ id: 'd1' })).toBeNull()
  })

  test('空串 / 非字符串 / 非对象 → null', () => {
    expect(vaultPathOf({ vault_path: '  ' })).toBeNull()
    expect(vaultPathOf({ vault_path: 42 })).toBeNull()
    expect(vaultPathOf(null)).toBeNull()
    expect(vaultPathOf('notes/a.md')).toBeNull()
  })
})

describe('isVaultAssetName', () => {
  test('白名单扩展名（含别名 / 锚点写法）', () => {
    expect(isVaultAssetName('x.png')).toBe(true)
    expect(isVaultAssetName('dir/y.PDF')).toBe(true)
    expect(isVaultAssetName('x.png|200')).toBe(true)
    expect(isVaultAssetName('x.png#page=1')).toBe(true)
  })

  test('非资源：笔记 / 无扩展名 / 代码文件', () => {
    expect(isVaultAssetName('某篇笔记')).toBe(false)
    expect(isVaultAssetName('note.md')).toBe(false)
    expect(isVaultAssetName('a.ts')).toBe(false)
  })
})

describe('resolveVaultAssetSrc', () => {
  test('相对路径按文档所在目录解析', () => {
    expect(resolveVaultAssetSrc('assets/x.png', 'notes/sub/doc.md')).toBe(
      '/api/v1/vault/raw/notes/sub/assets/x.png',
    )
    expect(resolveVaultAssetSrc('./x.png', 'doc.md')).toBe('/api/v1/vault/raw/x.png')
    expect(resolveVaultAssetSrc('../img/x.png', 'notes/sub/doc.md')).toBe(
      '/api/v1/vault/raw/notes/img/x.png',
    )
  })

  test('路径段按 URL 编码，中文目录可用', () => {
    expect(resolveVaultAssetSrc('图片/图 1.png', '笔记/doc.md')).toBe(
      '/api/v1/vault/raw/%E7%AC%94%E8%AE%B0/%E5%9B%BE%E7%89%87/%E5%9B%BE%201.png',
    )
  })

  test('越界 / 绝对路径 / 协议 URL / asset: / 非资源扩展名 → null（保持原样）', () => {
    expect(resolveVaultAssetSrc('../../escape.png', 'doc.md')).toBeNull()
    expect(resolveVaultAssetSrc('/abs/x.png', 'doc.md')).toBeNull()
    expect(resolveVaultAssetSrc('https://a.com/x.png', 'doc.md')).toBeNull()
    expect(resolveVaultAssetSrc('data:image/png;base64,AAA', 'doc.md')).toBeNull()
    expect(resolveVaultAssetSrc(`asset:${'a'.repeat(64)}`, 'doc.md')).toBeNull()
    expect(resolveVaultAssetSrc('note.md', 'doc.md')).toBeNull()
  })

  test('非 vault 文档（无 vaultPath）→ null', () => {
    expect(resolveVaultAssetSrc('assets/x.png', null)).toBeNull()
    expect(resolveVaultAssetSrc('assets/x.png', undefined)).toBeNull()
  })
})

describe('resolveVaultEmbedSrc', () => {
  test('![[x.png]] 交给服务端按唯一 basename 解析', () => {
    expect(resolveVaultEmbedSrc('x.png', 'doc.md')).toBe('/api/v1/vault/raw/x.png')
    expect(resolveVaultEmbedSrc('x.png|200', 'doc.md')).toBe('/api/v1/vault/raw/x.png')
    expect(resolveVaultEmbedSrc('图 1.png', 'doc.md')).toBe('/api/v1/vault/raw/%E5%9B%BE%201.png')
  })

  test('非资源嵌入 / 非 vault 文档 → null（保留原文）', () => {
    expect(resolveVaultEmbedSrc('某篇笔记', 'doc.md')).toBeNull()
    expect(resolveVaultEmbedSrc('x.png', null)).toBeNull()
  })
})
