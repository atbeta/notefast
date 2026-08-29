import { describe, expect, test } from 'bun:test'
import { isImageUploadConfigured } from '../useImageUploadEnabled'

describe('isImageUploadConfigured', () => {
  test('auto + 非空命令 → true', () => {
    expect(isImageUploadConfigured({ mode: 'auto', command: 'picfast' })).toBe(true)
  })

  test('off + 非空命令 → true（手动上传不依赖自动上传）', () => {
    expect(isImageUploadConfigured({ mode: 'off', command: 'picfast' })).toBe(true)
  })

  test('空命令 / 缺字段 → false', () => {
    expect(isImageUploadConfigured({ mode: 'auto', command: '' })).toBe(false)
    expect(isImageUploadConfigured({ mode: 'auto', command: '  ' })).toBe(false)
    expect(isImageUploadConfigured({ mode: 'off', command: '' })).toBe(false)
    expect(isImageUploadConfigured({})).toBe(false)
  })
})
