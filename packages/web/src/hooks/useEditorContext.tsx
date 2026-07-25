import React, { createContext, useContext, type ReactNode } from 'react'

export interface EditorHandle {
  docId: string
  getContent(): string
  getSelection(): { start: number; end: number; text: string } | null
  replaceSelection(text: string): void
  insertAtCursor(text: string): void
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
}

const EditorContext = createContext<EditorHandle | null>(null)

export function EditorProvider({ handle, children }: { handle: EditorHandle | null; children: ReactNode }) {
  return <EditorContext.Provider value={handle}>{children}</EditorContext.Provider>
}

export function useEditor(): EditorHandle | null {
  return useContext(EditorContext)
}
