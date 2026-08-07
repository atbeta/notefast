/**
 * 改写流式原地替换的渐进更新描述。
 * from/to clamp 到文档范围（外部编辑可能已改动文档长度），光标落在插入文本末尾。
 * 纯函数便于单测；dispatch 侧（CodeMirrorEditor.replaceRange）补 userEvent/scrollIntoView。
 */
export function buildReplaceRangeUpdate(
  docLength: number,
  from: number,
  to: number,
  text: string,
): { changes: { from: number; to: number; insert: string }; selection: { anchor: number } } {
  const clamp = (p: number) => Math.max(0, Math.min(p, docLength))
  const f = clamp(from)
  const t2 = clamp(to)
  // selection 是变更后坐标，须按变更后文档长度 clamp（文本变长时按变更前长度会截断光标）
  const postLength = docLength - (t2 - f) + text.length
  return {
    changes: { from: f, to: t2, insert: text },
    selection: { anchor: Math.max(0, Math.min(f + text.length, postLength)) },
  }
}
