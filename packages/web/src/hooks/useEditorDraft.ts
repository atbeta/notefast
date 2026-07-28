import { useCallback, useMemo } from 'react'

const DRAFT_PREFIX = 'notefast-draft-'

/** 草稿变更事件：saveDraft / clearDraft 后派发，侧栏草稿圆点据此实时刷新
 * （localStorage 的 storage 事件不覆盖同标签页，必须显式派发） */
export const DRAFT_CHANGED_EVENT = 'notefast:draft-changed'

/** 同步探测某文档是否有草稿（非 hook，供列表类组件逐条检查） */
export function hasDraftSync(docId: string): boolean {
  try {
    return localStorage.getItem(DRAFT_PREFIX + docId) !== null
  } catch {
    return false
  }
}

function emitDraftChanged(): void {
  try {
    window.dispatchEvent(new CustomEvent(DRAFT_CHANGED_EVENT))
  } catch { /* SSR / 测试环境无 window */ }
}

interface DraftPayload {
  content: string
  updatedAt: number
}

/** 读取草稿 payload；兼容历史纯字符串格式（无时间戳，updatedAt=0） */
function readPayload(docId: string): DraftPayload | null {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(DRAFT_PREFIX + docId)
  } catch {
    return null
  }
  if (raw === null) return null
  if (raw.startsWith('{')) {
    try {
      const parsed = JSON.parse(raw) as Partial<DraftPayload>
      if (typeof parsed.content === 'string') {
        return {
          content: parsed.content,
          updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
        }
      }
    } catch { /* 内容本身以 { 开头的纯文本草稿，落回 legacy 处理 */ }
  }
  return { content: raw, updatedAt: 0 }
}

export function useEditorDraft(docId: string) {
  const loadDraft = useCallback((): string | null => readPayload(docId)?.content ?? null, [docId])

  const saveDraft = useCallback(
    (content: string) => {
      try {
        localStorage.setItem(
          DRAFT_PREFIX + docId,
          JSON.stringify({ content, updatedAt: Date.now() } satisfies DraftPayload),
        )
        emitDraftChanged()
      } catch { /* ignore */ }
    },
    [docId],
  )

  const clearDraft = useCallback(() => {
    try {
      localStorage.removeItem(DRAFT_PREFIX + docId)
      emitDraftChanged()
    } catch { /* ignore */ }
  }, [docId])

  const hasDraft = useCallback((): boolean => hasDraftSync(docId), [docId])

  /** 草稿元信息（阅读态提示条用）；updatedAt=0 表示历史格式无时间戳 */
  const getDraftInfo = useCallback((): { updatedAt: number } | null => {
    const p = readPayload(docId)
    return p ? { updatedAt: p.updatedAt } : null
  }, [docId])

  return useMemo(
    () => ({ loadDraft, saveDraft, clearDraft, hasDraft, getDraftInfo }),
    [loadDraft, saveDraft, clearDraft, hasDraft, getDraftInfo],
  )
}
