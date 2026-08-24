/**
 * 快捷键展示：Mac 用符号，Windows / Linux 用 Ctrl / Shift / Alt。
 * 文案与按键绑定共用同一套解析，避免再写死 ⌘。
 */

export function isMacPlatform(platform = typeof navigator !== 'undefined' ? navigator.platform : ''): boolean {
  return /Mac|iPhone|iPad/i.test(platform)
}

/** 当前平台的主键修饰符（⌘ 或 Ctrl） */
export function shortcutModLabel(isMac = isMacPlatform()): string {
  return isMac ? '⌘' : 'Ctrl'
}

export function formatShortcutParts(keys: string[], isMac: boolean): string[] {
  return keys.flatMap((key) => {
    const lower = key.toLowerCase()
    if (lower === 'mod') return [shortcutModLabel(isMac)]
    if (lower === 'shift') return isMac ? ['⇧'] : ['Shift']
    if (lower === 'option' || lower === 'alt') return isMac ? ['⌥'] : ['Alt']
    return [key]
  })
}

/** Tooltip 等纯文本：⌘E / Ctrl+E */
export function shortcutLabel(keys: string[], isMac = isMacPlatform()): string {
  return formatShortcutParts(keys, isMac).join('+')
}
