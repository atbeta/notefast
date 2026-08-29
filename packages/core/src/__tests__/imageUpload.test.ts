import { describe, test, expect } from 'bun:test'
import {
  DEFAULT_IMAGE_UPLOAD_TIMEOUT_MS,
  emptyImageUploadConfig,
  hasImageUploadCommand,
  isImageUploadAuto,
  mergeImageUploadConfig,
} from '../imageUpload'

describe('imageUpload config', () => {
  test('空配置 → off + 空命令 + 默认超时', () => {
    const c = emptyImageUploadConfig()
    expect(c.mode).toBe('off')
    expect(c.command).toBe('')
    expect(c.args).toEqual([])
    expect(c.timeoutMs).toBe(DEFAULT_IMAGE_UPLOAD_TIMEOUT_MS)
  })

  test('mode 只接受 off/auto（其他值回退 off）', () => {
    const base = emptyImageUploadConfig()
    const auto = mergeImageUploadConfig({ mode: 'auto', command: 'picgo' }, base)
    expect(auto.mode).toBe('auto')
    expect(auto.command).toBe('picgo')
    const bad = mergeImageUploadConfig({ mode: 'always' as never }, base)
    expect(bad.mode).toBe('off')
  })

  test('command 去空格；args 只保留字符串', () => {
    const c = mergeImageUploadConfig(
      { command: '  picfast  ', args: ['upload', '--raw', 42 as unknown as string] },
      emptyImageUploadConfig(),
    )
    expect(c.command).toBe('picfast')
    expect(c.args).toEqual(['upload', '--raw'])
  })

  test('timeoutMs 钳制在 1000-300000 之间', () => {
    const c = mergeImageUploadConfig({ timeoutMs: 50 }, emptyImageUploadConfig())
    expect(c.timeoutMs).toBe(1000)
    const c2 = mergeImageUploadConfig({ timeoutMs: 999999 }, emptyImageUploadConfig())
    expect(c2.timeoutMs).toBe(300_000)
  })

  test('缺省字段沿用现有配置', () => {
    const base = mergeImageUploadConfig(
      { mode: 'auto', command: 'picgo', args: ['-c', 'x'], timeoutMs: 5000 },
      emptyImageUploadConfig(),
    )
    const next = mergeImageUploadConfig({ mode: 'off' }, base)
    expect(next.mode).toBe('off')
    expect(next.command).toBe('picgo')
    expect(next.args).toEqual(['-c', 'x'])
    expect(next.timeoutMs).toBe(5000)
  })

  test('hasImageUploadCommand 只看命令；isImageUploadAuto 还要 mode=auto', () => {
    expect(hasImageUploadCommand({ command: 'picfast' })).toBe(true)
    expect(hasImageUploadCommand({ command: '  ' })).toBe(false)
    expect(hasImageUploadCommand(null)).toBe(false)
    expect(isImageUploadAuto({ mode: 'off', command: 'picfast' })).toBe(false)
    expect(isImageUploadAuto({ mode: 'auto', command: 'picfast' })).toBe(true)
    expect(isImageUploadAuto({ mode: 'auto', command: '' })).toBe(false)
  })
})
