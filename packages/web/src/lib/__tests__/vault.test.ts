import { describe, test, expect } from 'bun:test'
import {
  isVaultAssetName,
  isVaultEnabled,
  recentConflictPaths,
  reconcileErrorCount,
  resolveVaultAssetSrc,
  resolveVaultEmbedSrc,
  vaultPathOf,
  type VaultStatus,
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
