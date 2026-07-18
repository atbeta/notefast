import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Edit3,
  Loader2,
  Eye,
  Pencil,
  Bold,
  Italic,
  Link2,
  Code,
  Quote,
  List,
  ListOrdered,
  Heading1,
  Heading2,
  Heading3,
  X,
  AlertCircle,
  Save,
  FilePlus2,
  Type,
  Hash,
  Clock3,
  Undo2,
  RotateCcw,
} from 'lucide-react'
import { parseMarkdownToBlocks, inputsToBlockTree } from '@notefast/core'
import type { Block } from '@notefast/core'
import { api } from '../hooks/useAPI'
import BlockRenderer from './BlockRenderer'

interface MarkdownEditorProps {
  docId: string
  onSaved: () => void
  autoEdit?: boolean
}

const DRAFT_PREFIX = 'notefast-draft-'
const CJK_WORDS_PER_MIN = 320

// ───────────────────────── 持久化草稿 ─────────────────────────

function loadDraft(docId: string): string | null {
  try { return localStorage.getItem(DRAFT_PREFIX + docId) } catch { return null }
}
function saveDraft(docId: string, content: string) {
  try { localStorage.setItem(DRAFT_PREFIX + docId, content) } catch { /* ignore */ }
}
function clearDraft(docId: string) {
  try { localStorage.removeItem(DRAFT_PREFIX + docId) } catch { /* ignore */ }
}

function hasDraft(docId: string): boolean {
  try { return localStorage.getItem(DRAFT_PREFIX + docId) !== null } catch { return false }
}

function relativeTime(date: Date | null): string {
  if (!date) return '—'
  const diff = Math.floor((Date.now() - date.getTime()) / 1000)
  if (diff < 5) return '刚刚'
  if (diff < 60) return `${diff} 秒前`
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟前`
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

// ───────────────────────── Markdown 快捷键识别 ─────────────────────────

/** 行首可识别的 markdown block-trigger 正则 */
const BLOCK_TRIGGER = /^(\s*)(?:#{1,6}|>|[-+*]\s|\d+\.\s|```)\s$/

// ───────────────────────── 入口 ─────────────────────────

export default function MarkdownEditor({ docId, onSaved, autoEdit = false }: MarkdownEditorProps) {
  const [editing, setEditing] = useState(autoEdit)

  const handleStartEdit = useCallback(() => setEditing(true), [])

  if (!editing) {
    return (
      <button
        onClick={handleStartEdit}
        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[13px] font-medium text-muted-foreground hover:text-foreground bg-card border border-border rounded-md transition-colors"
      >
        <Pencil className="w-3.5 h-3.5" strokeWidth={1.75} />
        编辑
      </button>
    )
  }

  return <EditorInline docId={docId} onSaved={onSaved} onClose={() => setEditing(false)} />
}

// ───────────────────────── 编辑器主体 ─────────────────────────

type Mode = 'edit' | 'view'

function EditorInline({ docId, onSaved, onClose }: { docId: string; onSaved: () => void; onClose: () => void }) {
  const [content, setContent] = useState('')
  const [initialContent, setInitialContent] = useState('')
  const [loadedAt, setLoadedAt] = useState<Date | null>(null)
  const [savedAt, setSavedAt] = useState<Date | null>(null)
  const [draftedAt, setDraftedAt] = useState<Date | null>(null)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [mode, setMode] = useState<Mode>('edit')
  const [showHelp, setShowHelp] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const lineNumbersRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [savedFlash, setSavedFlash] = useState(false)

  // ───── 加载（草稿优先，否则从服务端拉 markdown）─────
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const draft = loadDraft(docId)
    if (draft !== null) {
      setContent(draft)
      setInitialContent(draft)
      setDraftedAt(new Date())
      setLoadedAt(new Date())
      setLoading(false)
      return
    }
    api.get<{ markdown: string }>(`/docs/${docId}/export/markdown`)
      .then((r) => {
        if (cancelled) return
        setContent(r.markdown || '')
        setInitialContent(r.markdown || '')
        setLoadedAt(new Date())
      })
      .catch(() => { if (!cancelled) setContent('') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [docId])

  // 进入编辑后立刻定位到末尾
  useEffect(() => {
    if (!loading && textareaRef.current) {
      textareaRef.current.focus()
      const len = textareaRef.current.value.length
      textareaRef.current.setSelectionRange(len, len)
    }
  }, [loading])

  // 自动保存草稿（debounced 600ms）
  useEffect(() => {
    if (!loadedAt) return
    if (content === initialContent) return
    const id = setTimeout(() => {
      saveDraft(docId, content)
      setDraftedAt(new Date())
    }, 600)
    return () => clearTimeout(id)
  }, [content, docId, initialContent, loadedAt])

  // 同步滚动：line numbers 跟随 textarea
  const handleScroll = useCallback(() => {
    if (textareaRef.current && lineNumbersRef.current) {
      lineNumbersRef.current.scrollTop = textareaRef.current.scrollTop
    }
  }, [])

  // ───── 保存 / 取消 ─────
  const handleSave = useCallback(async () => {
    if (saving) return
    setSaving(true)
    setError(null)
    try {
      await api.put(`/docs/${docId}/markdown`, { markdown: content })
      setInitialContent(content)
      clearDraft(docId)
      setSavedAt(new Date())
      setSavedFlash(true)
      setTimeout(() => setSavedFlash(false), 1500)
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      saveDraft(docId, content)
    } finally {
      setSaving(false)
    }
  }, [saving, content, docId, onSaved])

  const handleCancel = useCallback(() => {
    saveDraft(docId, content)
    onClose()
  }, [docId, content, onClose])

  // ───── 工具栏动作：插入到光标位置（textarea-level）─────
  const insertAtCursor = useCallback(
    (text: string, opts?: { cursorOffset?: number; selectStart?: number }) => {
      const ta = textareaRef.current
      if (!ta) return
      const start = ta.selectionStart
      const end = ta.selectionEnd
      const before = content.slice(0, start)
      const after = content.slice(end)
      const newValue = before + text + after
      setContent(newValue)
      const cursorOffset = opts?.cursorOffset ?? text.length
      const cursorPos = start + cursorOffset
      requestAnimationFrame(() => {
        ta.focus()
        if (opts?.selectStart !== undefined) {
          ta.setSelectionRange(start + opts.selectStart, start + opts.selectStart)
        } else {
          ta.setSelectionRange(cursorPos, cursorPos)
        }
      })
    },
    [content],
  )

  const wrapSelection = useCallback(
    (leftWrap: string, rightWrap: string = leftWrap) => {
      const ta = textareaRef.current
      if (!ta) return
      const start = ta.selectionStart
      const end = ta.selectionEnd
      const before = content.slice(0, start)
      const middle = content.slice(start, end)
      const after = content.slice(end)
      const newValue = before + leftWrap + middle + rightWrap + after
      setContent(newValue)
      requestAnimationFrame(() => {
        ta.focus()
        if (start === end) {
          ta.setSelectionRange(start + leftWrap.length, start + leftWrap.length)
        } else {
          ta.setSelectionRange(start + leftWrap.length, end + leftWrap.length)
        }
      })
    },
    [content],
  )

  // ───── 全局键盘 ─────
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const ta = e.currentTarget
      const mod = e.metaKey || e.ctrlKey

      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault()
        handleSave()
        return
      }
      if (mod && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        setMode((m) => (m === 'edit' ? 'view' : 'edit'))
        return
      }
      if (mod && e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        const sel = content.slice(ta.selectionStart, ta.selectionEnd)
        const hasSel = sel.length > 0
        const linkText = hasSel ? sel : 'text'
        const ins = `[${linkText}](url)`
        if (hasSel) {
          wrapSelection('[', `](url)`)
        } else {
          insertAtCursor(ins, { cursorOffset: linkText.length + 3 })
        }
        return
      }

      // 块级 markdown shortcut：行末触发
      if (e.key === 'Enter' && !e.shiftKey) {
        const { selectionStart, value } = ta
        if (selectionStart === ta.selectionEnd) {
          const lineStart = value.lastIndexOf('\n', selectionStart - 1) + 1
          const currentLine = value.slice(lineStart, selectionStart)
          const m = currentLine.match(BLOCK_TRIGGER)
          if (m) {
            e.preventDefault()
            const prefix = (m[1] ?? '') + (m[2] ?? '')
            // 但 "```" 特殊：连按 Enter 时退出 code fence
            if (m[2] === '```' && /^\s*```/.test(value.slice(value.lastIndexOf('\n', selectionStart - 2), lineStart))) {
              // 上方已开过 ```，让用户退出
              const exit = value.slice(0, selectionStart) + '\n```\n' + value.slice(selectionStart)
              setContent(exit)
              requestAnimationFrame(() => {
                const pos = selectionStart + 5
                ta.setSelectionRange(pos, pos)
              })
              return
            }
            const indentLen = m[1]?.length ?? 0
            const fullPrefix = m[1] + m[2] + (m[2]?.endsWith(' ') ? '' : ' ')
            const before = value.slice(0, selectionStart)
            const after = value.slice(selectionStart)
            const insert = '\n' + fullPrefix
            const newPos = selectionStart + insert.length
            const newValue = before + insert + after
            setContent(newValue)
            requestAnimationFrame(() => ta.setSelectionRange(newPos, newPos))
            void indentLen
            void prefix
            return
          }
          // 空 list / quote 行按 Enter 直接退出 block
          const emptyList = /^(\s*)([-+*]|>)\s*$/.exec(currentLine)
          if (emptyList) {
            e.preventDefault()
            const before = value.slice(0, lineStart)
            const after = value.slice(selectionStart)
            // 整行删除前缀
            setContent(before + after)
            requestAnimationFrame(() => ta.setSelectionRange(lineStart, lineStart))
            return
          }
        }
      }

      // 智能配对括号 / 引号
      const PAIRS: Record<string, string> = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'" }
      const pair = PAIRS[e.key]
      if (pair) {
        const { selectionStart, selectionEnd, value } = ta
        if (selectionStart === selectionEnd) {
          // 普通括号
          const next = value[selectionStart]
          if (next === pair) {
            // 光标已经在同一个闭合括号上，跳过插入避免重复
            e.preventDefault()
            ta.setSelectionRange(selectionStart + 1, selectionStart + 1)
            return
          }
          e.preventDefault()
          const newValue = value.slice(0, selectionStart) + e.key + pair + value.slice(selectionEnd)
          setContent(newValue)
          requestAnimationFrame(() => ta.setSelectionRange(selectionStart + 1, selectionStart + 1))
          return
        }
        // 包裹选中
        e.preventDefault()
        const inner = value.slice(selectionStart, selectionEnd)
        const newValue = value.slice(0, selectionStart) + e.key + inner + pair + value.slice(selectionEnd)
        setContent(newValue)
        requestAnimationFrame(() => ta.setSelectionRange(selectionEnd + 2, selectionEnd + 2))
        return
      }

      // 退格时若自动配对的括号正成对，紧贴 -> 一并删除
      if (e.key === 'Backspace' && !mod) {
        const { selectionStart, selectionEnd, value } = ta
        if (selectionStart === selectionEnd && selectionStart > 0) {
          const left = value[selectionStart - 1]
          const right = value[selectionStart]
          const PAIRS2: Record<string, string> = { '(': ')', '[': ']', '{': '}' }
          if (PAIRS2[left] === right) {
            e.preventDefault()
            const newValue = value.slice(0, selectionStart - 1) + value.slice(selectionStart + 1)
            setContent(newValue)
            requestAnimationFrame(() => ta.setSelectionRange(selectionStart - 1, selectionStart - 1))
            return
          }
        }
      }

      if (e.key === 'Escape') {
        e.preventDefault()
        handleCancel()
      }
    },
    [content, handleSave, handleCancel, wrapSelection, insertAtCursor],
  )

  // 当按下 ⌘B / ⌘I / ⌘K 之外的修饰键也由 textarea 接收
  const handleShortcutKey = useCallback(
    (e: KeyboardEvent) => {
      const ta = textareaRef.current
      if (!ta) return
      const mod = e.metaKey || e.ctrlKey
      if (!mod) return
      if (document.activeElement !== ta) return
      const k = e.key.toLowerCase()
      if (k === 'b') { e.preventDefault(); wrapSelection('**', '**'); return }
      if (k === 'i') { e.preventDefault(); wrapSelection('*', '*'); return }
      if (k === 'e') { e.preventDefault(); wrapSelection('`', '`'); return }
    },
    [wrapSelection],
  )

  useEffect(() => {
    window.addEventListener('keydown', handleShortcutKey)
    return () => window.removeEventListener('keydown', handleShortcutKey)
  }, [handleShortcutKey])

  // ───── 统计指标 ─────
  const lines = content === '' ? 1 : content.split('\n').length
  const charCount = content.length
  // 估算字数：中英文混合 — 中文按 1 字/词、英文按 5 字符/词
  const cjkCount = (content.match(/[\u4e00-\u9fff]/g) || []).length
  const enCount = content.length - cjkCount
  const words = cjkCount + Math.floor(enCount / 5)
  const readMin = words <= 0 ? 0 : Math.max(1, Math.round(words / CJK_WORDS_PER_MIN))
  const dirty = content !== initialContent

  // ───── 视图（只读预览）─────
  const previewTree: Block | null = mode === 'view' && content
    ? (() => {
        try {
          const inputs = parseMarkdownToBlocks(content, '__preview__')
          const tree = inputsToBlockTree(inputs)
          return tree.length > 0 ? tree[0] : null
        } catch {
          return null
        }
      })()
    : null

  return (
    <div className="flex flex-col rounded-xl border border-border bg-card overflow-hidden mt-6 shadow-[var(--shadow-card)] animate-fade-in">
      {/* Toolbar — icon-first; all text labels live in tooltips */}
      <div className="flex flex-wrap items-center gap-x-1 gap-y-2 px-3 py-1.5 border-b border-border bg-muted/40 shrink-0">
        {/* Primary actions */}
        <div className="flex items-center gap-1 shrink-0 pl-0.5 pr-1.5">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || loading}
            title={saving ? '保存中…' : savedFlash ? '已保存' : '保存 (⌘S)'}
            aria-label={saving ? '保存中' : '保存'}
            className="inline-flex items-center justify-center w-7 h-7 rounded-md border border-primary bg-primary text-primary-foreground hover:brightness-110 active:scale-95 transition disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" strokeWidth={1.75} />}
          </button>
          <IconBtn title="取消 (Esc)" onClick={handleCancel}>
            <X className="w-3.5 h-3.5" strokeWidth={1.75} />
          </IconBtn>
        </div>

        {/* Block-type group */}
        <div className="flex items-center gap-0.5 px-1.5 py-0.5 rounded-md border border-border bg-background/60 flex-wrap">
          <IconBtn title="一级标题 (#)" onClick={() => insertAtCursor('\n# ')}>
            <Heading1 className="w-3.5 h-3.5" strokeWidth={1.75} />
          </IconBtn>
          <IconBtn title="二级标题 (##)" onClick={() => insertAtCursor('\n## ')}>
            <Heading2 className="w-3.5 h-3.5" strokeWidth={1.75} />
          </IconBtn>
          <IconBtn title="三级标题 (###)" onClick={() => insertAtCursor('\n### ')}>
            <Heading3 className="w-3.5 h-3.5" strokeWidth={1.75} />
          </IconBtn>
          <ToolbarDivider />
          <IconBtn title="无序列表 (-)" onClick={() => insertAtCursor('\n- ')}>
            <List className="w-3.5 h-3.5" strokeWidth={1.75} />
          </IconBtn>
          <IconBtn title="有序列表 (1.)" onClick={() => insertAtCursor('\n1. ')}>
            <ListOrdered className="w-3.5 h-3.5" strokeWidth={1.75} />
          </IconBtn>
          <IconBtn title="引用 (>)" onClick={() => insertAtCursor('\n> ')}>
            <Quote className="w-3.5 h-3.5" strokeWidth={1.75} />
          </IconBtn>
          <IconBtn title="代码块 (```)" onClick={() => insertAtCursor('\n```\n\n```\n', { cursorOffset: 5 })}>
            <Code className="w-3.5 h-3.5" strokeWidth={1.75} />
          </IconBtn>
        </div>

        {/* Inline format group */}
        <div className="flex items-center gap-0.5 px-1.5 py-0.5 rounded-md border border-border bg-background/60">
          <IconBtn title="加粗 (⌘B)" onClick={() => wrapSelection('**')}>
            <Bold className="w-3.5 h-3.5" strokeWidth={1.75} />
          </IconBtn>
          <IconBtn title="斜体 (⌘I)" onClick={() => wrapSelection('*')}>
            <Italic className="w-3.5 h-3.5" strokeWidth={1.75} />
          </IconBtn>
          <IconBtn title="行内代码 (⌘E)" onClick={() => wrapSelection('`')}>
            <Code className="w-3.5 h-3.5" strokeWidth={1.75} />
          </IconBtn>
          <IconBtn title="链接 (⌘⇧K)" onClick={() => {
            const sel = content.slice(textareaRef.current?.selectionStart ?? 0, textareaRef.current?.selectionEnd ?? 0)
            const hasSel = sel.length > 0
            const linkText = hasSel ? sel : 'text'
            const ins = `[${linkText}](url)`
            if (hasSel) wrapSelection('[', '](url)')
            else insertAtCursor(ins, { cursorOffset: linkText.length + 3 })
          }}>
            <Link2 className="w-3.5 h-3.5" strokeWidth={1.75} />
          </IconBtn>
        </div>

        <div className="flex items-center gap-1 text-muted-foreground shrink-0 ml-auto">
          <IconBtn
            title={mode === 'view' ? '返回编辑 (⌘P)' : '预览 (⌘P)'}
            onClick={() => setMode((m) => (m === 'edit' ? 'view' : 'edit'))}
            active={mode === 'view'}
          >
            {mode === 'view' ? <Edit3 className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" strokeWidth={1.75} />}
          </IconBtn>
          <IconBtn title="快捷键" onClick={() => setShowHelp((s) => !s)}>
            <span className="text-[12px] font-medium leading-none">?</span>
          </IconBtn>
        </div>
      </div>

      {/* Editor body */}
      {error && (
        <div className="px-4 py-2 bg-destructive/8 text-destructive text-[12px] flex items-center gap-2 border-b border-border">
          <AlertCircle className="w-3.5 h-3.5" />
          <span>{error}</span>
          <span className="ml-auto text-muted-foreground">已自动保存到本地草稿</span>
        </div>
      )}

      <div className="flex-1 relative min-h-[420px] max-h-[75vh] bg-editor-bg">
        {loading ? (
          <div className="absolute inset-0 flex items-center justify-center text-muted-foreground text-sm">
            <Loader2 className="w-4 h-4 animate-spin mr-2 text-primary" />
            加载文档…
          </div>
        ) : mode === 'view' ? (
          <div className="absolute inset-0 overflow-y-auto p-6 bg-background/40">
            {previewTree ? (
              <article className="reading-prose max-w-[68ch] mx-auto">
                <BlockRenderer block={previewTree} />
              </article>
            ) : (
              <div className="text-sm text-muted-foreground italic">（空文档，无法预览）</div>
            )}
          </div>
        ) : (
          <div className="absolute inset-0 flex">
            {/* 行号侧栏 */}
            <div
              ref={lineNumbersRef}
              className="shrink-0 w-12 py-4 px-1 bg-editor-gutter text-right font-mono text-[11px] text-muted-foreground/55 overflow-hidden select-none border-r border-border"
            >
              {Array.from({ length: lines }, (_, i) => (
                <div key={i + 1} className="leading-[1.65] tabular-nums" style={{ minHeight: '1.65em' }}>
                  {i + 1}
                </div>
              ))}
            </div>
            <textarea
              ref={textareaRef}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              onKeyDown={handleKeyDown}
              onScroll={handleScroll}
              spellCheck={false}
              className="flex-1 w-full py-4 px-5 font-mono text-[13.5px] leading-[1.65] text-foreground bg-transparent resize-none focus:outline-none placeholder:text-muted-foreground/40 selection:bg-primary/15"
              placeholder="开始写…（⌘B 加粗 / ⌘I 斜体 / # 标题 / - 列表；⌘P 切换预览；⌘S 保存）"
            />
          </div>
        )}
      </div>

      {/* Footer status bar — icon chips; tooltip = full info */}
      <div className="flex items-center gap-x-1 gap-y-1 flex-wrap px-2 py-1 border-t border-border bg-muted/30 shrink-0">
        {/* 字数 */}
        <IconStat icon={<Type className="w-3 h-3" strokeWidth={1.75} />}
          value={charCount} unit="字" title={`${charCount.toLocaleString('zh-CN')} 个字符`} />
        {/* 行数 */}
        <IconStat icon={<Hash className="w-3 h-3" strokeWidth={1.75} />}
          value={lines} unit="行" title={`${lines.toLocaleString('zh-CN')} 行`} />
        {/* 阅读 */}
        <IconStat icon={<Clock3 className="w-3 h-3" strokeWidth={1.75} />}
          value={readMin} unit="分钟" title={`预计阅读 ${readMin} 分钟`} />

        {/* 保存状态 — 纯色点；时间信息全靠 tooltip */}
        {savedFlash ? (
          <StatusDot tone="success" title="已保存 · 刚刚" />
        ) : dirty ? (
          <StatusDot tone="warning" title="未保存（自动存到本地草稿）" />
        ) : savedAt ? (
          <StatusDot tone="idle" title={`已保存 · ${relativeTime(savedAt)}`} />
        ) : null}

        {/* 草稿 */}
        {hasDraft(docId) && !savedFlash && (
          <span className="inline-flex items-center gap-1 text-muted-foreground/70">
            <button
              type="button"
              onClick={() => {
                clearDraft(docId)
                window.location.reload()
              }}
              title={`丢弃本地草稿（${draftedAt ? relativeTime(draftedAt) : '已保存'}）`}
              aria-label="丢弃本地草稿"
              className="inline-flex items-center justify-center w-6 h-6 rounded text-muted-foreground hover:text-destructive transition-colors"
            >
              <RotateCcw className="w-3 h-3" strokeWidth={1.75} />
            </button>
          </span>
        )}

        <span className="ml-auto inline-flex items-center gap-1">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            title="追加本地 Markdown 文件 (.md)"
            aria-label="追加本地 Markdown 文件"
            className="inline-flex items-center justify-center w-6 h-6 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            <FilePlus2 className="w-3 h-3" strokeWidth={1.75} />
          </button>
          <button
            type="button"
            onClick={() => {
              // 触发浏览器的原生 undo（focus 到 textarea 后用户再按 ⌘Z / Ctrl+Z）
              textareaRef.current?.focus()
            }}
            title="聚焦编辑器并让浏览器原生 ⌘Z / Ctrl+Z 处理撤销"
            aria-label="聚焦并准备撤销"
            className="inline-flex items-center justify-center w-6 h-6 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
          >
            <Undo2 className="w-3 h-3" strokeWidth={1.75} />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".md,.markdown,.txt"
            className="hidden"
            onChange={async (e) => {
              const file = e.target.files?.[0]
              if (!file) return
              const text = await file.text()
              insertAtCursor('\n\n' + text + '\n\n')
              e.target.value = ''
            }}
          />
        </span>
      </div>

      {/* Keyboard help sheet */}
      {showHelp && (
        <div className="border-t border-border bg-muted/40 p-3 text-[12px] text-muted-foreground grid grid-cols-2 gap-x-6 gap-y-1">
          <ShortcutsHelp kbd="⌘ S" desc="保存" />
          <ShortcutsHelp kbd="⌘ P" desc="切换 预览 / 编辑" />
          <ShortcutsHelp kbd="⌘ B / I / E" desc="加粗 / 斜体 / 行内代码" />
          <ShortcutsHelp kbd="⌘⇧ K" desc="插入链接" />
          <ShortcutsHelp kbd="# Enter" desc="自动加 heading 触发器" />
          <ShortcutsHelp kbd="- Enter" desc="自动加 list 触发器" />
          <ShortcutsHelp kbd="Esc" desc="取消（保留草稿）" />
        </div>
      )}
    </div>
  )
}

// ───────────────────────── 子组件 ─────────────────────────

function IconBtn({
  children,
  onClick,
  title,
  active,
}: {
  children: React.ReactNode
  onClick: () => void
  title: string
  active?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className={`inline-flex items-center justify-center w-7 h-7 rounded transition-colors ${
        active
          ? 'bg-primary/10 text-primary'
          : 'text-muted-foreground hover:text-foreground hover:bg-accent'
      }`}
    >
      {children}
    </button>
  )
}

function ToolbarDivider() {
  return <span className="w-px h-4 bg-border/60 mx-0.5" />
}

/** Icon + monospaced value chip for status bar (字 / 行 / 分钟) */
function IconStat({
  icon,
  value,
  unit,
  title,
}: {
  icon: React.ReactNode
  value: number
  unit: string
  title: string
}) {
  return (
    <span
      title={title}
      className="inline-flex items-center gap-1 px-1.5 h-6 rounded text-muted-foreground hover:bg-accent hover:text-foreground transition-colors cursor-default"
    >
      <span className="text-muted-foreground/80">{icon}</span>
      <span className="font-mono text-[11px] tabular-nums text-foreground/85 leading-none">
        {value.toLocaleString('zh-CN')}
      </span>
      <span className="text-[10.5px] text-muted-foreground/65 leading-none">{unit}</span>
    </span>
  )
}

/** Status dot (saved / dirty / idle) — single colored dot; tooltip = full info */
function StatusDot({
  tone,
  title,
}: {
  tone: 'success' | 'warning' | 'idle'
  title: string
}) {
  const dotColor =
    tone === 'success'
      ? 'bg-emerald-500'
      : tone === 'warning'
        ? 'bg-amber-500'
        : 'bg-border'
  return (
    <span
      title={title}
      aria-label={title}
      className="inline-flex items-center justify-center w-6 h-6 rounded text-muted-foreground hover:bg-accent hover:text-foreground transition-colors cursor-default"
    >
      <span className={`w-1.5 h-1.5 rounded-full ${dotColor}`} />
    </span>
  )
}

function ShortcutsHelp({ kbd, desc }: { kbd: string; desc: string }) {
  return (
    <div className="flex items-center gap-2">
      <kbd className="font-mono text-[10.5px] px-1.5 py-0.5 border border-border rounded bg-background text-foreground/85 whitespace-nowrap">
        {kbd}
      </kbd>
      <span>{desc}</span>
    </div>
  )
}
