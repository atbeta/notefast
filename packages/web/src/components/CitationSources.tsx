import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router-dom'
import { ChevronRight, ExternalLink } from 'lucide-react'
import { Tooltip } from './ui'

/** 检索引用（/ai/chat 的 citations 行） */
export interface Citation {
  block_id: string
  doc_id: string
  doc_title: string
  snippet: string
  score: number
  type?: string
}

/** 检索统计（/ai/chat 的 retrieval 行） */
export interface RetrievalInfo {
  fts_hits: number
  semantic_hits: number
  /** 语义路邻居上限；诊断用，满额不代表「命中了这么多」 */
  semantic_limit?: number
  reranked: boolean
  model?: string
  timing?: {
    fts_ms: number
    embed_query_ms: number
    semantic_ms: number
    rerank_ms: number
    total_ms: number
  }
}

export interface CitationGroup {
  doc_id: string
  doc_title: string
  items: Array<Citation & { ref: number }>
}

/** 单文档下默认展示的片段数；超出折叠，避免引用区压过正文 */
const CITATION_SNIPPET_PREVIEW = 3

/** 引用来源区（回答气泡下方）：按文档分组 + 检索诊断折叠面板 + 片段展开/收起 */
export default function CitationSources({
  groups,
  retrieval,
}: {
  groups: CitationGroup[]
  retrieval: RetrievalInfo | null
}) {
  const { t } = useTranslation()
  const [diagOpen, setDiagOpen] = useState(false)
  const [expandedDocs, setExpandedDocs] = useState<ReadonlySet<string>>(() => new Set())
  const totalSnippets = groups.reduce((n, g) => n + g.items.length, 0)

  const hasDiag = Boolean(
    retrieval && (
      retrieval.reranked ||
      retrieval.fts_hits > 0 ||
      retrieval.semantic_hits > 0 ||
      retrieval.timing
    ),
  )

  const toggleDoc = (docId: string) => {
    setExpandedDocs((prev) => {
      const next = new Set(prev)
      if (next.has(docId)) next.delete(docId)
      else next.add(docId)
      return next
    })
  }

  return (
    <div className="rounded-lg border border-border/60 bg-card/60 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border/50">
        <span className="w-1 h-3.5 rounded-full bg-primary shrink-0" aria-hidden />
        <span className="text-sm font-medium text-foreground">{t('chat.citationTitle')}</span>
        <span className="text-xs text-muted-foreground tabular-nums">
          {t('chat.citationStats', { docs: groups.length, segments: totalSnippets })}
        </span>
        {hasDiag && (
          <button
            type="button"
            onClick={() => setDiagOpen((v) => !v)}
            className="ml-auto inline-flex items-center gap-0.5 text-2xs text-muted-foreground hover:text-foreground transition-colors"
            aria-expanded={diagOpen}
          >
            {t('chat.retrievalDetail')}
            <ChevronRight className={`w-3 h-3 transition-transform ${diagOpen ? 'rotate-90' : ''}`} strokeWidth={1.75} />
          </button>
        )}
      </div>

      {diagOpen && retrieval && (
        <div className="px-3 py-1.5 border-b border-border/40 text-2xs text-muted-foreground leading-relaxed tabular-nums font-mono">
          {retrieval.reranked
            ? t('chat.rerankedWith', { model: retrieval.model || 'reranker' })
            : t('chat.hybridSearch')}
          {(retrieval.fts_hits > 0 || retrieval.semantic_hits > 0) &&
            t('chat.recall', {
              fts: retrieval.fts_hits,
              sem: retrieval.semantic_hits,
              limit: retrieval.semantic_limit ?? 20,
            })}
          {retrieval.timing && (
            <>
              {t('chat.totalTime', { ms: retrieval.timing.total_ms })}
              {retrieval.timing.fts_ms > 0 && t('chat.ftsTime', { ms: retrieval.timing.fts_ms })}
              {retrieval.timing.embed_query_ms > 0 && t('chat.embedTime', { ms: retrieval.timing.embed_query_ms })}
              {retrieval.timing.semantic_ms > 0 && t('chat.vectorTime', { ms: retrieval.timing.semantic_ms })}
              {retrieval.timing.rerank_ms > 0 && t('chat.rerankTime', { ms: retrieval.timing.rerank_ms })}
            </>
          )}
        </div>
      )}

      <div className="divide-y divide-border/40">
        {groups.map((group) => {
          const expanded = expandedDocs.has(group.doc_id)
          const visible = expanded
            ? group.items
            : group.items.slice(0, CITATION_SNIPPET_PREVIEW)
          const hidden = group.items.length - visible.length
          return (
            <div key={group.doc_id} className="px-3 py-2.5">
              <div className="flex items-center gap-1.5 min-w-0 mb-1.5">
                <Link
                  to={`/doc/${group.doc_id}`}
                  className="min-w-0 truncate text-sm font-medium text-foreground hover:text-primary transition-colors"
                >
                  {group.doc_title || t('chat.untitledDoc')}
                </Link>
                <span className="shrink-0 text-2xs text-muted-foreground tabular-nums">
                  {t('chat.segments', { n: group.items.length })}
                </span>
                <Tooltip label={t('chat.openDoc')}>
                  <Link
                    to={`/doc/${group.doc_id}`}
                    className="ml-auto shrink-0 p-0.5 text-muted-foreground/50 hover:text-primary transition-colors"
                    aria-label={t('chat.openDoc')}
                  >
                    <ExternalLink className="w-3 h-3" strokeWidth={1.75} />
                  </Link>
                </Tooltip>
              </div>
              <ol className="space-y-0.5">
                {visible.map((c) => (
                  <li key={c.block_id} id={`chat-cite-${c.ref}`} className="scroll-mt-3">
                    <Tooltip label={t('chat.jumpToBlock')}>
                      <Link
                        to={`/doc/${c.doc_id}#block-${c.block_id}`}
                        className="flex gap-2 rounded-md px-1.5 py-1.5 -mx-0.5 text-xs text-muted-foreground hover:bg-muted/70 hover:text-foreground transition-colors group/snip"
                      >
                        <span className="shrink-0 w-4 text-right font-mono text-2xs text-muted-foreground/55 group-hover/snip:text-primary/70 tabular-nums pt-px">
                          {c.ref}
                        </span>
                        <span className="min-w-0 line-clamp-2 leading-relaxed">{c.snippet}</span>
                      </Link>
                    </Tooltip>
                  </li>
                ))}
              </ol>
              {hidden > 0 && (
                <button
                  type="button"
                  onClick={() => toggleDoc(group.doc_id)}
                  className="mt-1 ml-5 text-xs text-primary/80 hover:text-primary transition-colors"
                >
                  {t('chat.expandMore', { n: hidden })}
                </button>
              )}
              {expanded && group.items.length > CITATION_SNIPPET_PREVIEW && (
                <button
                  type="button"
                  onClick={() => toggleDoc(group.doc_id)}
                  className="mt-1 ml-5 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  {t('chat.collapse')}
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
