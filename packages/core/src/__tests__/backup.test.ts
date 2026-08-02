import { describe, test, expect } from 'bun:test'
import {
  BACKUP_SECRET_MASK,
  CURRENT_SCHEMA_VERSION,
  assertSchemaCompatible,
  backupConfigSchema,
  buildManifestObjectKey,
  buildSnapshotObjectKey,
  emptyBackupConfig,
  isBackupManifest,
  mergeBackupConfig,
  normalizeBackupPrefix,
  publicBackupView,
  resolveBackupSecret,
} from '../backup'

describe('backup 领域模型', () => {
  test('emptyBackupConfig 默认关闭', () => {
    const c = emptyBackupConfig()
    expect(c.enabled).toBe(false)
    expect(c.s3).toBeNull()
    expect(c.intervalMs).toBe(3_600_000)
    expect(c.retentionDays).toBe(30)
  })

  test('resolveBackupSecret 保留脱敏与 undefined', () => {
    expect(resolveBackupSecret(BACKUP_SECRET_MASK, 'real')).toBe('real')
    expect(resolveBackupSecret(undefined, 'real')).toBe('real')
    expect(resolveBackupSecret('new-key', 'real')).toBe('new-key')
    expect(resolveBackupSecret('', 'real')).toBe('')
  })

  test('publicBackupView 脱敏密钥', () => {
    const pub = publicBackupView({
      version: 1,
      enabled: true,
      intervalMs: 1000,
      retentionDays: 7,
      s3: {
        bucket: 'b',
        region: 'r',
        accessKeyId: 'AKIA',
        secretAccessKey: 'SECRET',
      },
    })
    expect(pub.s3?.accessKeyId).toBe(BACKUP_SECRET_MASK)
    expect(pub.s3?.secretAccessKey).toBe(BACKUP_SECRET_MASK)
  })

  test('mergeBackupConfig 沿用旧密钥', () => {
    const existing = {
      version: 1 as const,
      enabled: true,
      intervalMs: 3600_000,
      retentionDays: 30,
      s3: {
        bucket: 'old',
        region: 'us-east-1',
        accessKeyId: 'OLD_AK',
        secretAccessKey: 'OLD_SK',
        prefix: 'nf/',
      },
    }
    const merged = mergeBackupConfig(
      {
        version: 1,
        enabled: true,
        intervalMs: 7200_000,
        retentionDays: 14,
        s3: {
          bucket: 'new',
          region: 'auto',
          accessKeyId: BACKUP_SECRET_MASK,
          secretAccessKey: BACKUP_SECRET_MASK,
          prefix: 'nf',
        },
      },
      existing,
    )
    expect(merged.s3?.bucket).toBe('new')
    expect(merged.s3?.accessKeyId).toBe('OLD_AK')
    expect(merged.s3?.secretAccessKey).toBe('OLD_SK')
    expect(merged.s3?.prefix).toBe('nf/')
    expect(merged.intervalMs).toBe(7200_000)
  })

  test('mergeBackupConfig 密钥整体省略（undefined）时沿用旧值', () => {
    const existing = {
      version: 1 as const,
      enabled: true,
      intervalMs: 3_600_000,
      retentionDays: 30,
      s3: {
        bucket: 'b',
        region: 'r',
        accessKeyId: 'REAL_AK',
        secretAccessKey: 'REAL_SK',
      },
    }
    const merged = mergeBackupConfig(
      {
        version: 1,
        enabled: true,
        intervalMs: 0,
        retentionDays: 7,
        s3: { bucket: 'b', region: 'r' },
      },
      existing,
    )
    expect(merged.s3?.accessKeyId).toBe('REAL_AK')
    expect(merged.s3?.secretAccessKey).toBe('REAL_SK')
    expect(merged.intervalMs).toBe(0)
  })

  test('backupConfigSchema 允许省略 s3 密钥（intervalMs 0 保留）', () => {
    const parsed = backupConfigSchema.parse({
      enabled: true,
      intervalMs: 0,
      retentionDays: 7,
      s3: { bucket: 'b', region: 'r', prefix: 'p' },
    })
    expect(parsed.intervalMs).toBe(0)
    expect(parsed.s3?.accessKeyId).toBeUndefined()
    expect(parsed.s3?.secretAccessKey).toBeUndefined()
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
