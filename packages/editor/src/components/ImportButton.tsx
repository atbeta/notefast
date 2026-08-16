import { useState } from 'react'
import { Send, Check, Loader2, AlertCircle } from 'lucide-react'
import { importToNoteFast } from '../lib/importToNoteFast'
import { loadSettings } from '../lib/settings'
import type { ImportPayload } from '@notefast/shared'

interface ImportButtonProps {
  /** 导入 payload（markdown + source.external_id + 可选 title） */
  payload: ImportPayload
  /** 是否已配置 NoteFast（false 时禁用） */
  disabled?: boolean
  /** 导入成功后回调（跳转 / 提示） */
  onImported?: (docId: string, deduplicated: boolean) => void
}

type ImportState = 'idle' | 'importing' | 'done' | 'error'

/**
 * 「导入到 NoteFast」按钮 + 状态机。
 * 未配置 NoteFast 时禁用（设置页配置后可启用）；失败展示错误文案。
 */
export default function ImportButton({ payload, disabled, onImported }: ImportButtonProps) {
  const [state, setState] = useState<ImportState>('idle')
  const [error, setError] = useState('')

  const handleImport = async () => {
    const settings = loadSettings()
    if (!settings.noteFastUrl) {
      setState('error')
      setError('未配置 NoteFast 地址，请到设置页配置')
      return
    }
    setState('importing')
    setError('')
    try {
      const result = await importToNoteFast(settings, payload)
      setState('done')
      onImported?.(result.docId, result.deduplicated)
      // 2s 后复位，允许重复导入
      setTimeout(() => setState('idle'), 2000)
    } catch (e) {
      setState('error')
      setError(e instanceof Error ? e.message : '导入失败')
    }
  }

  const icon =
    state === 'importing' ? (
      <Loader2 className="h-4 w-4 animate-spin" />
    ) : state === 'done' ? (
      <Check className="h-4 w-4" />
    ) : state === 'error' ? (
      <AlertCircle className="h-4 w-4" />
    ) : (
      <Send className="h-4 w-4" />
    )

  const label =
    state === 'importing' ? '导入中…' : state === 'done' ? '已导入' : state === 'error' ? '重试' : '导入到 NoteFast'

  return (
    <div className="inline-flex flex-col items-end">
      <button
        type="button"
        className="inline-flex items-center gap-1.5 rounded-md bg-ink px-3 py-1.5 text-sm text-ink-foreground transition-colors hover:bg-ink-hover disabled:cursor-not-allowed disabled:opacity-45"
        onClick={handleImport}
        disabled={disabled || state === 'importing'}
        title={disabled ? '未配置 NoteFast，请到设置页配置' : '导入当前内容到 NoteFast'}
      >
        {icon}
        {label}
      </button>
      {state === 'error' && error && (
        <span className="mt-1 text-xs text-destructive">{error}</span>
      )}
    </div>
  )
}
