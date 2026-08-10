/**
 * 实体面板 — 文档页右栏（桌面）/ 堆叠区（移动端）展示本文涉及的实体
 *
 * AI 在写入时自动抽取的实体以 chips 形式低调呈现；点击 chip 展开该实体的
 * 相关笔记列表（GET /entities/:id）。无实体时整体不渲染；加载失败静默降级，
 * 不阻塞文档页。
 */

import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { Loader2 } from 'lucide-react'
import { api } from '../hooks/useAPI'
import { useApiQuery } from '../hooks/useApiQuery'
import { useAiCapabilities } from '../hooks/useAiCapabilities'
import {
  entityDocStatusLabel,
  type DocEntity,
  type EntityDetail,
  type EntityMention,
} from '../lib/entities'

/** 单条提及：笔记标题 + 非常态状态标注 + 所在块摘要，点击跳转文档 */
export function MentionRow({ mention }: { mention: EntityMention }) {
  const { t } = useTranslation()
  return (
    <Link
      to={'/doc/' + mention.doc_id}
      className="group block px-2.5 py-2 -mx-1 rounded-lg hover:bg-accent transition-colors"
    >
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 truncate text-[12.5px] text-muted-foreground group-hover:text-foreground transition-colors">
          {mention.doc_title || t('entityPanel.untitled')}
        </span>
        {mention.doc_status !== 'note' && (
          <span className="shrink-0 rounded border border-border/60 bg-muted/40 px-1 py-px text-[10px] text-muted-foreground/80">
            {entityDocStatusLabel(mention.doc_status) ?? mention.doc_status}
          </span>
        )}
      </div>
      {mention.block_snippet && (
        <p className="mt-0.5 text-[12px] text-muted-foreground/75 line-clamp-2 leading-relaxed">
          {mention.block_snippet}
        </p>
      )}
    </Link>
  )
}

/** 实体的相关笔记列表（EntityPanel 与实体列表页共用）；失败静默 */
export function EntityMentions({ entityId }: { entityId: string }) {
  const { t } = useTranslation()
  const { data, loading, error } = useApiQuery(
    () => api.get<EntityDetail>(`/entities/${entityId}`),
    [entityId],
  )
  if (loading && !data) {
    return (
      <div className="flex items-center gap-1.5 px-1 py-2 text-[12px] text-muted-foreground/70">
        <Loader2 className="w-3 h-3 animate-spin" strokeWidth={1.75} />
        {t('common.loading')}
      </div>
    )
  }
  if (error || !data) return null
  if (data.mentions.length === 0) {
    return <div className="px-1 py-1 text-[12px] text-muted-foreground/60">{t('entityPanel.noRelatedNotes')}</div>
  }
  return (
    <div className="flex flex-col gap-1">
      {data.mentions.map((m) => (
        <MentionRow key={m.block_id} mention={m} />
      ))}
    </div>
  )
}

interface EntityPanelProps {
  docId: string
  /** aside = 桌面右栏紧凑标题；stack = 移动端堆叠标题；bare = 标签页内无标题 */
  variant: 'aside' | 'stack' | 'bare'
}

export default function EntityPanel({ docId, variant }: EntityPanelProps) {
  const { t } = useTranslation()
  const ai = useAiCapabilities()
  const { data, error, loading } = useApiQuery(
    () => api.get<{ entities: DocEntity[] }>(`/docs/${docId}/entities`),
    [docId],
  )
  const [openId, setOpenId] = useState<string | null>(null)
  // 切换文档时收起展开态（右栏组件跨文档复用）
  useEffect(() => { setOpenId(null) }, [docId])

  const entities = data?.entities ?? []
  const empty = !loading && (error || entities.length === 0)

  // aside/stack：无实体时完全隐藏；bare（标签页）展示空态
  if (variant !== 'bare' && (error || !data || entities.length === 0)) return null

  return (
    <section>
      {variant !== 'bare' && (
        <h3
          className={
            variant === 'aside'
              ? 'text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground mb-2'
              : 'text-sm font-medium text-foreground mb-3'
          }
          title={t('entityPanel.aiRecognize')}
        >
          {t('entityPanel.title')}
        </h3>
      )}
      {loading && entities.length === 0 ? (
        <div className="px-1 text-[12px] text-muted-foreground/70">{t('common.loading')}</div>
      ) : empty ? (
        <div className="px-1 text-[12px] text-muted-foreground/60 leading-relaxed">
          {ai.ready && !ai.chat
            ? t('entityPanel.noEntitiesNeedChat')
            : t('entityPanel.noEntitiesYet')}
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-1.5">
            {entities.map((e) => (
              <button
                key={e.id}
                type="button"
                onClick={() => setOpenId(openId === e.id ? null : e.id)}
                className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[12px] transition-colors ${
                  openId === e.id
                    ? 'border-primary/40 bg-primary-soft text-primary'
                    : 'border-border/70 text-muted-foreground hover:text-foreground hover:border-foreground/20'
                }`}
              >
                {e.display}
                <span className="text-[10px] text-muted-foreground/70 tabular-nums">
                  {e.mention_count}
                </span>
              </button>
            ))}
          </div>
          {openId !== null && (
            <div className="mt-2.5 border-t border-border/50 pt-2.5">
              <EntityMentions entityId={openId} />
            </div>
          )}
        </>
      )}
    </section>
  )
}
