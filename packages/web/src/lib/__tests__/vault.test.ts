import { describe, test, expect } from 'bun:test'
import {
  isVaultEnabled,
  recentConflictPaths,
  reconcileErrorCount,
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
