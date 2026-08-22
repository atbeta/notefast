/**
 * 列表行骨架屏：按真实列表行结构 1:1 绘制（图标 + 标题条 + 元信息条 + 尾部短条），
 * 加载完成后内容无缝替换、不跳变。home / inbox / archived / entities 共用，
 * 避免各页用「三个空卡片」这类与内容结构不符的占位。
 */
/** 设置面板 / 侧栏块：短标题 + 几行 + 一块内容 */
export function PanelSkeleton() {
  return (
    <div className="animate-pulse space-y-3 px-1 py-2" aria-hidden>
      <div className="h-3.5 bg-secondary rounded w-1/4" />
      <div className="h-2.5 bg-secondary rounded w-3/4" />
      <div className="h-2.5 bg-secondary rounded w-2/3" />
      <div className="h-20 bg-secondary rounded-md" />
    </div>
  )
}

/** 文档/详情正文占位 */
export function DetailSkeleton() {
  return (
    <div className="animate-pulse space-y-4 px-1 py-2" aria-hidden>
      <div className="h-6 bg-secondary rounded w-2/5" />
      <div className="space-y-2">
        <div className="h-3 bg-secondary rounded w-full" />
        <div className="h-3 bg-secondary rounded w-11/12" />
        <div className="h-3 bg-secondary rounded w-4/5" />
      </div>
      <div className="h-40 bg-secondary rounded-md" />
    </div>
  )
}

export function ListRowsSkeleton({ rows = 5, withIcon = true }: { rows?: number; withIcon?: boolean }) {
  return (
    <div className="space-y-0.5">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="animate-pulse px-3 py-2 flex items-center gap-3">
          {withIcon && <div className="w-7 h-7 rounded-md bg-secondary shrink-0" />}
          <div className="flex-1 space-y-1.5">
            <div className="h-3.5 bg-secondary rounded w-1/3" />
            <div className="h-2.5 bg-secondary rounded w-1/5" />
          </div>
          <div className="h-2.5 bg-secondary rounded w-12 shrink-0" />
        </div>
      ))}
    </div>
  )
}
