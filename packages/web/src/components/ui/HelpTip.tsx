import { HelpCircle } from 'lucide-react'
import { Tooltip } from './Tooltip'

export function HelpTip({ label }: { label: string }) {
  return (
    <Tooltip label={label}>
      <HelpCircle className="w-3.5 h-3.5 text-muted-foreground/50 hover:text-muted-foreground cursor-help transition-colors" strokeWidth={1.75} />
    </Tooltip>
  )
}
