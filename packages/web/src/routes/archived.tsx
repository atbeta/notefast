/**
 * 归档（Archived）— 保留但不再活跃的内容
 *
 * 文档 status=archived；恢复为 note 后回到「所有文档」。
 * 归档文档默认不进 AI 检索（可显式包含），不污染回答。
 */

import { useState, useEffect, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { Archive, ArchiveRestore, Loader2, Search } from 'lucide-react'
import type { DocSummary, SearchResult } from '@notefast/core'
import { api } from '../hooks/useAPI'
import { useApiQuery } from '../hooks/useApiQuery'
import { useDocChanges } from '../hooks/useDocEvents'
import { formatRelative } from '../lib/time'
import DocActionsMenu from '../components/DocActionsMenu'
import PageHeader from '../components/PageHeader'
import { ListRowsSkeleton } from '../components/ui'

export default function ArchivedPage() {
  const [busyId, setBusyId] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  // hits === null 表示未在搜索（展示全量列表）
  const [hits, setHits] = useState<SearchResult[] | null>(null)
  const [searching, setSearching] = useState(false)

  const { data, loading, error, refetch } = useApiQuery(
    () => api.get<DocSummary[]>('/docs/list?status=archived'),
    [],
  )
  // 外部通道（MCP / AI 聊天）归档或恢复时即时刷新
  useDocChanges(() => refetch())
  // 原 .catch(() => setDocs([])) 语义：拉取失败按空列表渲染（空归档 UI）
  const docs = error ? [] : (data ?? [])

  // 内容级搜索（FTS，限归档集合），300ms 防抖；清空关键词回到全量列表
  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setHits(null)
      setSearching(false)
      return
    }
    setSearching(true)
    const t = setTimeout(() => {
      api.get<SearchResult[]>(`/search?q=${encodeURIComponent(q)}&status=archived&limit=50`)
        .then((r) => setHits(Array.isArray(r) ? r : []))
        .catch(() => setHits([]))
        .finally(() => setSearching(false))
    }, 300)
    return () => clearTimeout(t)
  }, [query])

  // block 级命中按文档去重（root_id 即文档 id），保留 FTS 相关度顺序，并带上首个命中的 snippet
  const matchedDocs = useMemo(() => {
    if (!hits) return null
    const seen = new Set<string>()
    const out: Array<{ doc: DocSummary; snippet: string }> = []
    for (const h of hits) {
      const docId = h.block.root_id || h.block.id
      if (seen.has(docId)) continue
      seen.add(docId)
      const doc = docs.find((d) => d.id === docId)
      if (doc) out.push({ doc, snippet: h.snippet })
    }
    return out
  }, [hits, docs])

  const restore = async (id: string) => {
    setBusyId(id)
    try {
      await api.patch(`/docs/${id}/status`, { status: 'note' })
      refetch()
    } finally {
      setBusyId(null)
    }
  }

  const renderDocRow = (doc: DocSummary, snippet?: string) => (
    <div
      key={doc.id}
      className="card-interactive px-3 py-2 group flex items-center gap-3"
    >
      <div className="w-7 h-7 rounded-md bg-muted/70 text-foreground/55 grid place-items-center shrink-0">
        <Archive className="w-3.5 h-3.5" strokeWidth={1.5} />
      </div>
      <div className="min-w-0 flex-1">
        <Link to={`/doc/${doc.id}`} className="block">
          <h3 className="font-medium text-[14px] text-foreground tracking-[-0.005em] truncate leading-snug">
            {doc.title || '未命名'}
          </h3>
        </Link>
        {snippet && (
          <p className="text-[12px] text-muted-foreground truncate mt-0.5">{snippet}</p>
        )}
        <p className="text-[11.5px] text-muted-foreground mt-0.5 font-mono tabular-nums">
          归档于 {formatRelative(doc.updated_at)}
        </p>
      </div>
      <div className="flex items-center gap-0.5 shrink-0">
        <button
          type="button"
          disabled={busyId === doc.id}
          onClick={() => restore(doc.id)}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-md text-[11.5px] text-foreground hover:bg-accent transition-colors opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
          title="恢复为笔记（回到所有文档）"
        >
          {busyId === doc.id ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" strokeWidth={1.75} />
          ) : (
            <ArchiveRestore className="w-3.5 h-3.5" strokeWidth={1.75} />
          )}
          恢复为笔记
        </button>
        <DocActionsMenu
          doc={{ ...doc, status: 'archived' }}
          surface="archived"
          onDone={refetch}
        />
      </div>
    </div>
  )

  return (
    <div className="animate-fade-in">
      <PageHeader innerClassName="flex items-center justify-between gap-4">
        <div className="min-w-0 flex items-center gap-2">
          <h1 className="text-[15px] font-medium text-foreground truncate tracking-[-0.005em]">
            归档
          </h1>
          {!loading && docs.length > 0 && (
            <span className="font-mono text-[11px] text-muted-foreground/80 tabular-nums shrink-0">
              {docs.length}
            </span>
          )}
        </div>
      </PageHeader>

      <div className="w-full max-w-4xl mx-auto px-4 sm:px-8 pt-7 pb-16 space-y-5">
        <p className="text-[13px] text-muted-foreground leading-relaxed px-1">
          已过时但想保留的内容（如已解决的问题记录）。归档后不出现在所有文档，AI 回答默认也不再引用。
        </p>

        {loading ? (
          <ListRowsSkeleton rows={4} />
        ) : docs.length === 0 ? (
          <div className="px-3 py-14 flex flex-col items-center text-center">
            <div className="empty-icon-tile">
              <Archive className="w-5 h-5" />
            </div>
            <h3 className="text-[15px] font-medium text-foreground mb-1.5">没有归档文档</h3>
            <p className="text-[13px] text-muted-foreground mb-5 max-w-[280px] leading-relaxed">
              在文档页点「归档」，把过时但想保留的内容收进来。
            </p>
          </div>
        ) : (
          <>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground/60" strokeWidth={1.75} />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="搜索归档内容…"
                className="w-full rounded-lg border border-border bg-card pl-9 pr-8 py-2 text-[13px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:ring-1 focus:ring-foreground/20"
              />
              {searching && (
                <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 animate-spin text-muted-foreground/60" strokeWidth={1.75} />
              )}
            </div>

            {matchedDocs ? (
              matchedDocs.length === 0 ? (
                <p className="px-1 py-8 text-center text-[13px] text-muted-foreground">
                  没有匹配「{query.trim()}」的归档文档
                </p>
              ) : (
                <div className="grid gap-0.5">
                  {matchedDocs.map(({ doc, snippet }) => renderDocRow(doc, snippet))}
                </div>
              )
            ) : (
              <div className="grid gap-0.5">
                {docs.map((doc) => renderDocRow(doc))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
