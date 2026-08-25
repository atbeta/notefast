/** 当前打开文档收到 SSE 后怎么处理 */
export type OpenDocChangeAction = 'ignore' | 'reload' | 'defer' | 'gone'

/**
 * 阅读态跟库；编辑态不覆盖未保存稿；删除立刻离开。
 * 其它文档的事件忽略。
 */
export function openDocChangeAction(
  ev: { doc_id: string; kind: 'created' | 'updated' | 'deleted' },
  openId: string | undefined,
  isEditing: boolean,
): OpenDocChangeAction {
  if (!openId || ev.doc_id !== openId) return 'ignore'
  if (ev.kind === 'deleted') return 'gone'
  if (ev.kind === 'created' || ev.kind === 'updated') {
    return isEditing ? 'defer' : 'reload'
  }
  return 'ignore'
}
