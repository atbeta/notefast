import { describe, expect, test } from 'bun:test'
import { formatShortcutParts, isMacPlatform, shortcutLabel, shortcutModLabel } from '../shortcutDisplay'

describe('isMacPlatform', () => {
  test('识别 Mac / iOS', () => {
    expect(isMacPlatform('MacIntel')).toBe(true)
    expect(isMacPlatform('iPhone')).toBe(true)
    expect(isMacPlatform('iPad')).toBe(true)
  })

  test('Windows / Linux 不是 Mac', () => {
    expect(isMacPlatform('Win32')).toBe(false)
    expect(isMacPlatform('Linux x86_64')).toBe(false)
  })
})

describe('shortcutLabel', () => {
  test('Windows 用 Ctrl+ 文字', () => {
    expect(shortcutLabel(['mod', 'E'], false)).toBe('Ctrl+E')
    expect(shortcutLabel(['mod', '⇧K'], false)).toBe('Ctrl+⇧K')
    expect(shortcutModLabel(false)).toBe('Ctrl')
  })

  test('Mac 用符号', () => {
    expect(shortcutLabel(['mod', 'E'], true)).toBe('⌘+E')
    expect(formatShortcutParts(['mod', 'shift', 'D'], true)).toEqual(['⌘', '⇧', 'D'])
    expect(formatShortcutParts(['mod', 'shift', 'D'], false)).toEqual(['Ctrl', 'Shift', 'D'])
  })
})
