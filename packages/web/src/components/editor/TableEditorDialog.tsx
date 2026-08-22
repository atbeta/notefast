/**
 * 外挂表格网格编辑：点预览打开，改完一次写回 GFM。
 * 不进 CodeMirror widget（避免 contenteditable 与 CM 选区打架）。
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslation } from 'react-i18next'
import { Plus, X } from 'lucide-react'
import { useFocusTrap } from '../../hooks/useFocusTrap'
import { Button, HelpTip, Tooltip } from '../ui'
import { NO_AUTOFILL_TOKEN } from '../../lib/noAutofill'
import {
  addCol,
  addRow,
  deleteCol,
  deleteRow,
  padTable,
  setCell,
  type ParsedTable,
} from './cm/tableModel'

interface TableEditorDialogProps {
  open: boolean
  table: ParsedTable | null
  onDone: (table: ParsedTable) => void
  onEditSource: (table: ParsedTable) => void
}

const emptyTable = (): ParsedTable => ({ header: [''], aligns: ['none'], body: [] })

function CellField({
  value,
  onChange,
  onEnter,
  ariaLabel,
  row,
  col,
}: {
  value: string
  onChange: (value: string) => void
  onEnter: () => void
  ariaLabel: string
  row: number
  col: number
}) {
  const ref = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${Math.max(el.scrollHeight, 40)}px`
  }, [value])

  return (
    <textarea
      ref={ref}
      rows={1}
      value={value}
      data-row={row}
      data-col={col}
      autoComplete={NO_AUTOFILL_TOKEN}
      aria-label={ariaLabel}
      spellCheck={false}
      onChange={(e) => onChange(e.target.value.replace(/\n/g, ' '))}
      onKeyDown={(e) => {
        if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
        e.preventDefault()
        onEnter()
      }}
    />
  )
}

export default function TableEditorDialog({
  open,
  table,
  onDone,
  onEditSource,
}: TableEditorDialogProps) {
  const { t } = useTranslation()
  const containerRef = useRef<HTMLDivElement>(null)
  useFocusTrap(containerRef, open)

  const [draft, setDraft] = useState<ParsedTable>(emptyTable)
  const draftRef = useRef(draft)
  draftRef.current = draft

  useEffect(() => {
    if (open && table) setDraft(padTable(table))
  }, [open, table])

  const finish = useCallback(
    (thenSource: boolean) => {
      const next = draftRef.current
      if (thenSource) onEditSource(next)
      else onDone(next)
    },
    [onDone, onEditSource],
  )

  useEffect(() => {
    if (!open) return
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      finish(false)
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [open, finish])

  const focusCell = (row: number, col: number) => {
    const el = containerRef.current?.querySelector<HTMLTextAreaElement>(
      `textarea[data-row="${row}"][data-col="${col}"]`,
    )
    el?.focus()
  }

  const handleEnter = (row: number, col: number) => {
    const nextRow = row + 1
    const bodyLen = draftRef.current.body.length
    if (nextRow >= bodyLen) {
      setDraft((d) => addRow(d))
      setTimeout(() => focusCell(nextRow, col), 0)
    } else {
      focusCell(nextRow, col)
    }
  }

  if (!open) return null

  const cols = draft.header.length
  const canDeleteCol = cols > 1

  return createPortal(
    <div className="fixed inset-0 z-dialog flex items-center justify-center p-4">
      <div
        className="fixed inset-0 bg-black/40 backdrop-blur-[2px]"
        onClick={() => finish(false)}
        aria-hidden="true"
      />
      <div
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="table-editor-title"
        className="relative bg-card rounded-lg border border-border shadow-floating shadow-black/40 w-full max-w-4xl max-h-[min(80vh,720px)] flex flex-col overflow-hidden animate-fade-in"
      >
        {/* 网格放 DOM 前部，焦点落到第一个单元格；视觉上标题仍在顶 */}
        <div className="order-2 flex-1 min-h-0 overflow-auto px-4 py-3">
          <div className="nf-table-editor-grid">
            <table style={{ minWidth: `calc(${cols} * 8.5rem + 36px)` }}>
              <thead>
                <tr>
                  {draft.header.map((cell, ci) => (
                    <th key={ci}>
                      <CellField
                        row={-1}
                        col={ci}
                        value={cell}
                        ariaLabel={t('tableEditor.headerCell', { n: ci + 1 })}
                        onChange={(v) => setDraft((d) => setCell(d, -1, ci, v))}
                        onEnter={() => handleEnter(-1, ci)}
                      />
                      {canDeleteCol && (
                        <Tooltip label={t('tableEditor.deleteCol')} className="nf-table-editor-del absolute top-0.5 right-0.5">
                          <button
                            type="button"
                            tabIndex={-1}
                            onClick={() => setDraft((d) => deleteCol(d, ci))}
                            className="btn-icon-ghost"
                            aria-label={t('tableEditor.deleteCol')}
                          >
                            <X className="w-3.5 h-3.5" strokeWidth={1.75} />
                          </button>
                        </Tooltip>
                      )}
                    </th>
                  ))}
                  <th className="nf-table-editor-gutter">
                    <Tooltip label={t('tableEditor.addCol')} className="w-full justify-center">
                      <button
                        type="button"
                        onClick={() => setDraft((d) => addCol(d))}
                        className="inline-flex items-center justify-center w-7 h-7 rounded-[var(--radius-btn)] text-muted-foreground hover:text-foreground hover:bg-accent"
                        aria-label={t('tableEditor.addCol')}
                      >
                        <Plus className="w-3.5 h-3.5" strokeWidth={1.75} />
                      </button>
                    </Tooltip>
                  </th>
                </tr>
              </thead>
              <tbody>
                {draft.body.map((row, ri) => (
                  <tr key={ri}>
                    {row.map((cell, ci) => (
                      <td key={ci}>
                        <CellField
                          row={ri}
                          col={ci}
                          value={cell}
                          ariaLabel={t('tableEditor.bodyCell', { row: ri + 1, col: ci + 1 })}
                          onChange={(v) => setDraft((d) => setCell(d, ri, ci, v))}
                          onEnter={() => handleEnter(ri, ci)}
                        />
                      </td>
                    ))}
                    <td className="nf-table-editor-gutter">
                      <Tooltip label={t('tableEditor.deleteRow')} className="nf-table-editor-del w-full justify-center">
                        <button
                          type="button"
                          tabIndex={-1}
                          onClick={() => setDraft((d) => deleteRow(d, ri))}
                          className="btn-icon-ghost"
                          aria-label={t('tableEditor.deleteRow')}
                        >
                          <X className="w-3.5 h-3.5" strokeWidth={1.75} />
                        </button>
                      </Tooltip>
                    </td>
                  </tr>
                ))}
                <tr>
                  <td colSpan={cols}>
                    <button
                      type="button"
                      className="nf-table-editor-add"
                      onClick={() => setDraft((d) => addRow(d))}
                    >
                      <Plus className="w-3.5 h-3.5" strokeWidth={1.75} />
                      {t('tableEditor.addRow')}
                    </button>
                  </td>
                  <td className="nf-table-editor-gutter" />
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        <div className="order-1 flex items-center justify-between gap-3 px-4 py-3 border-b border-border/60 shrink-0">
          <div className="flex items-center gap-1.5 min-w-0">
            <h3 id="table-editor-title" className="text-md font-medium text-foreground tracking-tight">
              {t('tableEditor.title')}
            </h3>
            <HelpTip label={t('tableEditor.markdownHint')} />
          </div>
          <div className="flex items-center gap-1.5">
            <Button type="button" variant="ghost" size="sm" className="min-w-0" onClick={() => finish(true)}>
              {t('tableEditor.editSource')}
            </Button>
            <Button type="button" variant="primary" size="sm" className="min-w-0" onClick={() => finish(false)}>
              {t('tableEditor.done')}
            </Button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
