/** 当前界面快捷键清单（只用于展示，不负责监听） */

export type ShortcutPage = 'none' | 'doc-reading' | 'doc-editing'

export interface ShortcutItem {
  id: string
  keys: string[]
  labelKey: string
}

export interface ShortcutGroups {
  local: ShortcutItem[]
  global: ShortcutItem[]
}

const GLOBAL: ShortcutItem[] = [
  { id: 'search', keys: ['mod', 'K'], labelKey: 'shortcuts.search' },
  { id: 'new', keys: ['mod', 'N'], labelKey: 'shortcuts.newDoc' },
  { id: 'ai', keys: ['mod', 'J'], labelKey: 'shortcuts.aiChat' },
  { id: 'sidebar', keys: ['mod', '\\'], labelKey: 'shortcuts.sidebar' },
  { id: 'theme', keys: ['mod', 'shift', 'D'], labelKey: 'shortcuts.theme' },
  { id: 'zoomIn', keys: ['mod', '='], labelKey: 'shortcuts.zoomIn' },
  { id: 'zoomOut', keys: ['mod', '-'], labelKey: 'shortcuts.zoomOut' },
  { id: 'zoomReset', keys: ['mod', '0'], labelKey: 'shortcuts.zoomReset' },
]

const DOC_READING: ShortcutItem[] = [
  { id: 'enterEdit', keys: ['mod', 'E'], labelKey: 'shortcuts.enterEdit' },
  { id: 'find', keys: ['mod', 'F'], labelKey: 'shortcuts.find' },
]

const DOC_EDITING_BASE: ShortcutItem[] = [
  { id: 'save', keys: ['mod', 'S'], labelKey: 'shortcuts.save' },
  { id: 'preview', keys: ['mod', 'P'], labelKey: 'shortcuts.preview' },
  { id: 'find', keys: ['mod', 'F'], labelKey: 'shortcuts.find' },
  { id: 'bold', keys: ['mod', 'B'], labelKey: 'shortcuts.bold' },
  { id: 'italic', keys: ['mod', 'I'], labelKey: 'shortcuts.italic' },
  { id: 'inlineCode', keys: ['mod', 'E'], labelKey: 'shortcuts.inlineCode' },
  { id: 'link', keys: ['mod', '⇧K'], labelKey: 'shortcuts.link' },
]

const AI_CONTINUE: ShortcutItem[] = [
  { id: 'aiContinue', keys: ['mod', 'Enter'], labelKey: 'shortcuts.aiContinue' },
  { id: 'aiAccept', keys: ['Tab'], labelKey: 'shortcuts.aiAccept' },
]

export function shortcutGroups(input: {
  page: ShortcutPage
  aiContinue?: boolean
  demoActive?: boolean
}): ShortcutGroups {
  const global = input.demoActive
    ? [...GLOBAL, { id: 'exitDemo', keys: ['Esc'], labelKey: 'shortcuts.exitDemo' }]
    : GLOBAL

  if (input.page === 'doc-reading') {
    return { local: DOC_READING, global }
  }
  if (input.page === 'doc-editing') {
    const local = input.aiContinue
      ? [...DOC_EDITING_BASE, ...AI_CONTINUE]
      : DOC_EDITING_BASE
    return { local, global }
  }
  return { local: [], global }
}
