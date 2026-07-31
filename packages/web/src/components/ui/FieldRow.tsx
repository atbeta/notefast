import type { ReactNode } from 'react'
import { AlertCircle } from 'lucide-react'

/** 表单行：小写大写化 label + 控件插槽 + 可选字段级错误红字 */
export function FieldRow({ label, children, error, hint }: { label: string; children: ReactNode; error?: string; hint?: string }) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-4">
        <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">{label}</label>
        {hint && <span className="text-[11px] text-muted-foreground/70">{hint}</span>}
      </div>
      <div className="mt-1">{children}</div>
      {error && (
        <div
          role="alert"
          className="mt-1 text-[11px] text-destructive flex items-start gap-1.5"
        >
          <AlertCircle className="w-3 h-3 mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
    </div>
  )
}
