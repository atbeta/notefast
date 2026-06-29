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

export default function HeroAction({
  icon: Icon,
  onPrimary,
  title,
  subtitle,
  chip,
  ariaLabel,
  size = 'lg',
}: HeroActionProps) {
  const orbSize = size === 'lg' ? 'hero-orb-lg' : size === 'md' ? 'hero-orb-md' : 'hero-orb-sm'
  const haloSize = size === 'sm' ? 'orb-halo-sm' : ''
  const titleSize = size === 'lg' ? 'text-base' : 'text-sm'

  return (
    <div className="flex flex-col items-center text-center pt-1 pb-4 select-none">
      <div className="relative">
        <span className={'orb-halo ' + haloSize} aria-hidden="true" />
        <button
          type="button"
          onClick={onPrimary}
          aria-label={ariaLabel}
          className={'hero-orb orb-float ' + orbSize}
        >
          <Icon strokeWidth={2.25} />
        </button>
      </div>
      <h2 className={'mt-5 font-semibold text-foreground ' + titleSize + ' tracking-[-0.022em]'}>
        {title}
      </h2>
      <p className="mt-1 text-xs text-muted-foreground max-w-[36ch] leading-relaxed">{subtitle}</p>
      {chip && (
        <button
          type="button"
          onClick={chip.onClick}
          className="mt-3 inline-flex items-center gap-1 px-2.5 py-1 rounded-full border border-border bg-card text-[11px] text-muted-foreground hover:text-foreground hover:border-primary/40 transition-colors"
        >
          {chip.icon && <chip.icon className="w-3 h-3" strokeWidth={2.25} />}
          <span>{chip.label}</span>
        </button>
      )}
    </div>
  )
}