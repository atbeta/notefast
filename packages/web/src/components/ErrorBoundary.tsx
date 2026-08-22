import { Component, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { reportBoundaryError } from '../lib/errorReporter'
import { Button } from './ui/Button'

interface Props {
  children: ReactNode
  /**
   * 自定义错误 UI：用于路由级（紧凑、嵌入 Layout 之内）或自定义场景。
   * 不传则使用 root 边界的全屏兜底。
   */
  fallback?: (error: Error, reset: () => void) => ReactNode
}

interface State {
  error: Error | null
}

function RootErrorFallback({ error, onReset }: { error: Error; onReset: () => void }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6 gap-3 bg-background">
      <div className="text-[15px] font-medium text-foreground">{t('errorBoundary.title')}</div>
      <div className="text-[12px] text-muted-foreground break-all max-w-lg text-center leading-relaxed">
        {error.message || String(error)}
      </div>
      {error.stack && (
        <div className="flex flex-col items-center gap-2 max-w-xl w-full">
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="text-[12px] text-muted-foreground hover:text-foreground"
          >
            {open ? t('common.hideDetails') : t('common.showDetails')}
          </button>
          {open && (
            <pre className="text-[10.5px] text-muted-foreground/70 whitespace-pre-wrap break-all max-h-48 overflow-y-auto border border-border rounded-md p-2.5 bg-muted/30 w-full">
              {error.stack}
            </pre>
          )}
        </div>
      )}
      <div className="flex gap-2">
        <Button type="button" variant="primary" onClick={onReset}>
          {t('errorBoundary.retry')}
        </Button>
        <Button type="button" variant="ghost" onClick={() => { window.location.href = '/' }}>
          {t('common.backHome')}
        </Button>
      </div>
    </div>
  )
}

/**
 * React 错误边界。任何子组件渲染 / 生命周期抛错都不再白屏：
 *  - root 形态（全屏）：友好文案 + 可折叠 stack
 *  - 自定义 fallback：路由级 / 局部用，Layout 继续可用
 *
 * 局限：仅能捕获 render / 生命周期 / constructor 中的同步抛错。
 * 事件回调、setState / useEffect 异步、Promise rejection 不在此列——
 * 那些走 toast.error() 与全局 window.onerror / unhandledrejection。
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: { componentStack?: string }): void {
    console.error('[ErrorBoundary]', error)
    reportBoundaryError(error, info.componentStack)
  }

  handleReset = (): void => {
    this.setState({ error: null })
  }

  render(): ReactNode {
    const { error } = this.state
    if (error) {
      if (this.props.fallback) return this.props.fallback(error, this.handleReset)
      return <RootErrorFallback error={error} onReset={this.handleReset} />
    }
    return this.props.children
  }
}
