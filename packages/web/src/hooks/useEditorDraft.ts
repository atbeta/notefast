import { useCallback } from 'react'

const DRAFT_PREFIX = 'notefast-draft-'

export function useEditorDraft(docId: string) {
  const loadDraft = useCallback((): string | null => {
    try { return localStorage.getItem(DRAFT_PREFIX + docId) } catch { return null }
  }, [docId])

  const saveDraft = useCallback(
    (content: string) => {
      try { localStorage.setItem(DRAFT_PREFIX + docId, content) } catch { /* ignore */ }
    },
    [docId],
  )

  const clearDraft = useCallback(() => {
    try { localStorage.removeItem(DRAFT_PREFIX + docId) } catch { /* ignore */ }
  }, [docId])

  const hasDraft = useCallback((): boolean => {
    try { return localStorage.getItem(DRAFT_PREFIX + docId) !== null } catch { return false }
  }, [docId])

  return { loadDraft, saveDraft, clearDraft, hasDraft }
}
