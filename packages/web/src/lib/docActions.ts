/**
 * 文档溢出菜单按生命周期拼装：收集箱 / 归档 / 笔记的操作不同。
 * 入口（列表、侧栏、收集箱页）只提供 surface 作兜底；优先用 doc.status。
 */

export type DocLifecycle = 'note' | 'inbox' | 'archived'

export type DocActionId =
  | 'open-tab'
  | 'rename'
  | 'promote'
  | 'restore'
  | 'archive'
  | 'share'
  | 'export'
  | 'ai-exclude'
  | 'delete'

export function resolveDocLifecycle(
  status: string | undefined,
  surface?: string,
): DocLifecycle {
  if (status === 'inbox' || status === 'archived' || status === 'note') return status
  if (surface === 'inbox' || surface === 'archived') return surface
  return 'note'
}

/** 收集箱：整理/丢弃；归档：恢复/导出；笔记：归档/分享/AI 可见性。 */
export function docActionIdsFor(kind: DocLifecycle): DocActionId[] {
  switch (kind) {
    case 'inbox':
      return ['open-tab', 'rename', 'promote', 'delete']
    case 'archived':
      return ['open-tab', 'rename', 'restore', 'export', 'delete']
    default:
      return ['open-tab', 'rename', 'archive', 'share', 'export', 'ai-exclude', 'delete']
  }
}
