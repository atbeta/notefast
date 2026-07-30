import { useCallback, useMemo } from 'react'

const DRAFT_PREFIX = 'notefast-draft-'

export const DRAFT_CHANGED_EVENT = 'notefast:draft-changed'

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
  } catch { /* SSR */ }
}

export interface DraftPayload {
  content: string
  updatedAt: number
  serverUpdatedAt: string
}

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
          serverUpdatedAt: typeof parsed.serverUpdatedAt === 'string' ? parsed.serverUpdatedAt : '',
        }
      }
    } catch { /* 内容本身以 { 开头的纯文本草稿，落回 legacy */ }
  }
  return { content: raw, updatedAt: 0, serverUpdatedAt: '' }
}

export function useEditorDraft(docId: string) {
  const loadDraft = useCallback((): string | null => readPayload(docId)?.content ?? null, [docId])

  const getDraftPayload = useCallback((): DraftPayload | null => readPayload(docId), [docId])

  const saveDraft = useCallback(
    (content: string, serverUpdatedAt?: string) => {
      try {
        const prev = readPayload(docId)
        localStorage.setItem(
          DRAFT_PREFIX + docId,
          JSON.stringify({
            content,
            updatedAt: Date.now(),
            serverUpdatedAt: serverUpdatedAt ?? prev?.serverUpdatedAt ?? '',
          } satisfies DraftPayload),
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

  const getDraftInfo = useCallback((): { updatedAt: number } | null => {
    const p = readPayload(docId)
    return p ? { updatedAt: p.updatedAt } : null
  }, [docId])

  return useMemo(
    () => ({ loadDraft, saveDraft, clearDraft, hasDraft, getDraftInfo, getDraftPayload }),
    [loadDraft, saveDraft, clearDraft, hasDraft, getDraftInfo, getDraftPayload],
  )
}
