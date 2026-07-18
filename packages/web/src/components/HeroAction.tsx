import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

interface ChipItem {
  icon?: LucideIcon
  label: ReactNode
  onClick?: () => void
}

interface HeroActionProps {
  icon: LucideIcon
  onPrimary: () => void
  title: string
  subtitle: string
  ariaLabel: string
  chip?: ChipItem
  size?: 'lg' | 'md' | 'sm'
}

/**
 * Home 顶部主入口。
 *
 * Wave 1 重构：去掉 gradient orb + halo + float 动画（典型"AI 创企"视觉签名），
 * 换成克制的小方块图标 + 干净标题/副标题/标签。让 hero 不抢文档内容，
 * 让"高亮"留给真正的文字，而不是发光的球。
 */
export default function HeroAction({
  icon: Icon,
  onPrimary,
  title,
  subtitle,
  chip,
  ariaLabel,
  size = 'lg',
}: HeroActionProps) {
  const tileSize =
    size === 'lg' ? 'w-11 h-11' : size === 'md' ? 'w-9 h-9' : 'w-7 h-7'
  const iconSize = size === 'lg' ? 'w-5 h-5' : size === 'md' ? 'w-4 h-4' : 'w-3.5 h-3.5'
  const titleSize = size === 'lg' ? 'text-lg font-semibold' : 'text-base font-semibold'

  return (
    <div className="flex flex-col items-center text-center select-none px-2 py-4">
      <button
        type="button"
        onClick={onPrimary}
        aria-label={ariaLabel}
        className={`${tileSize} grid place-items-center rounded-lg border border-border bg-card text-foreground shadow-sm hover:border-primary/40 hover:text-primary transition-colors`}
      >
        <Icon className={iconSize} strokeWidth={1.75} />
      </button>
      <h2 className={`mt-3 ${titleSize} tracking-[-0.02em] text-foreground`}>
        {title}
      </h2>
      <p className="mt-1 text-[13px] text-muted-foreground max-w-[36ch] leading-relaxed">
        {subtitle}
      </p>
      {chip && (
        <button
          type="button"
          onClick={chip.onClick}
          className="mt-3 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] text-muted-foreground hover:text-foreground transition-colors"
        >
          {chip.icon && <chip.icon className="w-3 h-3" strokeWidth={1.75} />}
          <span>{chip.label}</span>
        </button>
      )}
    </div>
  )
}
