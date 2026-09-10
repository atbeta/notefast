/**
 * vault 目录树（侧栏，RFC 0005 U-8）
 *
 * vault 的目录是用户自己组织的，db 时代那套「扁平文档 + 标签/智能视图」的侧栏体现不出来。
 * 这里按 `GET /api/v1/vault/tree?path=` **一层一层拉**（展开哪层拉哪层），
 * 点目录名 → 文档列表按该目录过滤（`/?dir=…`）；点文件名 → 直接打开文档。
 *
 * 纯展示部分（`VaultTreeRows`）与取数部分（默认导出）分开，前者可无 DOM 单测。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link, useSearchParams } from 'react-router-dom'
import { ChevronRight, FileText, Folder, FolderOpen } from 'lucide-react'
import { api } from '../hooks/useAPI'
import { useApiQuery } from '../hooks/useApiQuery'

export interface VaultTreeDir {
  path: string
  name: string
  /** 该目录下直接的 .md 数 */
  files: number
  /** 该目录及子目录的 .md 总数 */
  total: number
}

export interface VaultTreeFile {
  path: string
  name: string
  doc_id: string
}

export interface VaultTreeLevel {
  path: string
  dirs: VaultTreeDir[]
  files: VaultTreeFile[]
}

export interface VaultTreeRowsProps {
  /** 本层要渲染的目录路径（'' = 根） */
  path: string
  level: VaultTreeLevel
  /** 已加载的各层（展开的子目录从这里取） */
  levels: Record<string, VaultTreeLevel | undefined>
  expanded: ReadonlySet<string>
  /** 当前生效的目录过滤（来自 `?dir=`） */
  activeDir: string | null
  onToggle: (dir: string) => void
  onNavigate?: () => void
}

const ROW_CLS =
  'group flex items-center gap-1 rounded-md text-sidebar-muted hover:bg-[var(--primary-softer)] hover:text-sidebar-accent-foreground transition-colors'
const ACTIVE_CLS = 'bg-primary-soft text-primary font-medium hover:bg-[rgb(var(--primary)_/_0.16)]'
const COUNT_CLS =
  'ml-auto inline-flex items-center justify-center min-w-[18px] h-[18px] px-1.5 rounded-full text-2xs font-medium bg-sidebar-accent/70 text-sidebar-muted/80 tabular-nums'

/** 路径深度（'' = 0） */
function depthOf(relPath: string): number {
  return relPath === '' ? 0 : relPath.split('/').length
}

/** 缩进按深度 */
function indentAt(depth: number): { paddingLeft: string } {
  return { paddingLeft: `${8 + depth * 12}px` }
}

/**
 * 递归渲染一层：目录（可展开）→ 展开后跟子层；最后是本层直属文件。
 * 纯展示，不取数——取数在默认导出的容器里。
 */
export function VaultTreeRows({
  path,
  level,
  levels,
  expanded,
  activeDir,
  onToggle,
  onNavigate,
}: VaultTreeRowsProps) {
  const { t } = useTranslation()

  return (
    <div className="flex flex-col gap-0.5">
      {level.dirs.map((dir) => {
        const isOpen = expanded.has(dir.path)
        const child = levels[dir.path]
        const isActive = activeDir === dir.path
        return (
          <div key={dir.path} className="flex flex-col gap-0.5">
            <div
              className={`${ROW_CLS} ${isActive ? ACTIVE_CLS : ''}`}
              style={indentAt(depthOf(path))}
            >
              <button
                type="button"
                aria-label={isOpen ? t('sidebar.vaultTreeCollapse') : t('sidebar.vaultTreeExpand')}
                aria-expanded={isOpen}
                data-tree-toggle={dir.path}
                onClick={() => onToggle(dir.path)}
                className="shrink-0 w-5 h-5 flex items-center justify-center rounded hover:bg-sidebar-accent/60"
              >
                <ChevronRight
                  className={`w-3.5 h-3.5 transition-transform ${isOpen ? 'rotate-90' : ''}`}
                  strokeWidth={1.75}
                />
              </button>
              <Link
                to={`/?dir=${encodeURIComponent(dir.path)}`}
                onClick={onNavigate}
                title={dir.path}
                data-tree-dir={dir.path}
                className="flex items-center gap-1.5 min-w-0 flex-1 py-1.5 pr-2 text-base"
              >
                {isOpen ? (
                  <FolderOpen className="w-4 h-4 shrink-0" strokeWidth={1.75} />
                ) : (
                  <Folder className="w-4 h-4 shrink-0" strokeWidth={1.75} />
                )}
                <span className="truncate">{dir.name}</span>
                {dir.total > 0 && <span className={COUNT_CLS}>{dir.total}</span>}
              </Link>
            </div>
            {isOpen && child && (
              <VaultTreeRows
                path={dir.path}
                level={child}
                levels={levels}
                expanded={expanded}
                activeDir={activeDir}
                onToggle={onToggle}
                onNavigate={onNavigate}
              />
            )}
          </div>
        )
      })}

      {level.files.map((file) => (
        <Link
          key={file.path}
          to={`/doc/${file.doc_id}`}
          onClick={onNavigate}
          title={file.path}
          data-tree-file={file.path}
          className={`${ROW_CLS} py-1.5 pr-2 text-base`}
          style={indentAt(depthOf(path) + 1)}
        >
          <FileText className="w-4 h-4 shrink-0 opacity-70" strokeWidth={1.75} />
          <span className="truncate">{file.name}</span>
        </Link>
      ))}
    </div>
  )
}

/** 侧栏容器：拉根层，展开时按需拉子层 */
export default function VaultFolderTree({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useTranslation()
  const [searchParams] = useSearchParams()
  const [levels, setLevels] = useState<Record<string, VaultTreeLevel | undefined>>({})
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set<string>())
  const activeDir = searchParams.get('dir')

  const { data: root, error } = useApiQuery(
    () => api.get<VaultTreeLevel>('/vault/tree'),
    [],
  )

  /** 根层来自查询，展开的子层来自 levels；合并视图避免在渲染里改 state */
  const allLevels = useMemo<Record<string, VaultTreeLevel | undefined>>(
    () => (root ? { ...levels, root } : levels),
    [levels, root],
  )

  const load = useCallback(async (dir: string) => {
    try {
      const level = await api.get<VaultTreeLevel>(`/vault/tree?path=${encodeURIComponent(dir)}`)
      setLevels((prev) => ({ ...prev, [dir]: level }))
    } catch {
      /* 目录读失败：保持折叠，不弹错误墙 */
    }
  }, [])

  const handleToggle = useCallback(
    (dir: string) => {
      setExpanded((prev) => {
        const next = new Set(prev)
        if (next.has(dir)) next.delete(dir)
        else {
          next.add(dir)
          if (!levels[dir]) void load(dir)
        }
        return next
      })
    },
    [levels, load],
  )

  // 直接打开 /?dir=… 时把祖先目录都展开，用户能看到自己在哪
  useEffect(() => {
    if (!activeDir) return
    const parts = activeDir.split('/').filter(Boolean)
    const ancestors = parts.slice(1).map((_, i) => parts.slice(0, i + 1).join('/'))
    if (ancestors.length === 0) return
    setExpanded((prev) => {
      const next = new Set(prev)
      for (const dir of ancestors) next.add(dir)
      return next
    })
    for (const dir of ancestors) {
      if (!levels[dir]) void load(dir)
    }
    // levels 故意不进依赖：否则每次加载完都会再跑一遍
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDir])

  if (error) return null
  if (!root) {
    return <p className="px-2.5 py-1.5 text-xs text-sidebar-muted">{t('sidebar.vaultTreeLoading')}</p>
  }
  if (root.dirs.length === 0 && root.files.length === 0) {
    return <p className="px-2.5 py-1.5 text-xs text-sidebar-muted">{t('sidebar.vaultTreeEmpty')}</p>
  }

  return (
    <VaultTreeRows
      path=""
      level={root}
      levels={allLevels}
      expanded={expanded}
      activeDir={activeDir}
      onToggle={handleToggle}
      onNavigate={onNavigate}
    />
  )
}
