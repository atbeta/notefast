import { describe, test, expect } from 'bun:test'
import {
  CURRENT_SCHEMA_VERSION,
  assertSchemaCompatible,
  backupConfigSchema,
  buildManifestObjectKey,
  buildSnapshotObjectKey,
  emptyBackupConfig,
  isBackupManifest,
  mergeBackupConfig,
  normalizeBackupPrefix,
} from '../backup'

describe('backup 领域模型', () => {
  test('emptyBackupConfig 默认关闭', () => {
    const c = emptyBackupConfig()
    expect(c.enabled).toBe(false)
    expect(c.locationId).toBeNull()
    expect(c.prefix).toBe('')
    expect(c.retentionDays).toBe(30)
  })

  test('mergeBackupConfig 归一化前缀、沿用 locationId', () => {
    const merged = mergeBackupConfig(
      {
        enabled: true,
        locationId: 'loc-1',
        prefix: '/nf/',
        retentionDays: 14,
      },
      emptyBackupConfig(),
    )
    expect(merged.locationId).toBe('loc-1')
    expect(merged.prefix).toBe('nf/')
    expect(merged.retentionDays).toBe(14)
  })

  test('backupConfigSchema 接受 locationId + prefix', () => {
    const parsed = backupConfigSchema.parse({
      enabled: true,
      locationId: 'loc-1',
      prefix: 'p',
      retentionDays: 7,
    })
    expect(parsed.locationId).toBe('loc-1')
    expect(parsed.prefix).toBe('p')
  })

  test('normalizeBackupPrefix / object keys', () => {
    expect(normalizeBackupPrefix('a/b')).toBe('a/b/')
    expect(normalizeBackupPrefix('/a/b/')).toBe('a/b/')
    expect(normalizeBackupPrefix('')).toBe('')
    const key = buildSnapshotObjectKey('nf', 'abc123', new Date('2026-01-02T03:04:05.678Z'))
    expect(key).toBe('nf/snapshots/2026-01-02T03-04-05-678Z-abc123.db')
    expect(buildManifestObjectKey(key)).toBe('nf/snapshots/2026-01-02T03-04-05-678Z-abc123.manifest.json')
  })

  test('assertSchemaCompatible 拒绝未来版本', () => {
    expect(() => assertSchemaCompatible(CURRENT_SCHEMA_VERSION)).not.toThrow()
    expect(() => assertSchemaCompatible(CURRENT_SCHEMA_VERSION + 1)).toThrow(/高于当前程序/)
    expect(() => assertSchemaCompatible(0)).toThrow(/无效/)
  })

  test('isBackupManifest', () => {
    expect(
      isBackupManifest({
        app: 'notefast',
        kind: 'sqlite-snapshot',
        version: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        objectKey: 'x.db',
        sizeBytes: 1,
        sha256: 'abc',
        schemaVersion: 1,
      }),
    ).toBe(true)
    expect(isBackupManifest({ app: 'other' })).toBe(false)
  })
})
