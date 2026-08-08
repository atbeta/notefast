import { Component, type ReactNode } from 'react'
import { reportBoundaryError } from '../lib/errorReporter'

interface Props {
  children: ReactNode
  /**
   * 自定义错误 UI：用于路由级（紧凑、嵌入 Layout 之内）或自定义场景。
   * 不传则使用 root 边界的全屏兜底（带 stack 方便本地排查）。
   */
  fallback?: (error: Error, reset: () => void) => ReactNode
}

interface State {
  error: Error | null
}

/**
 * React 错误边界。任何子组件渲染 / 生命周期抛错都不再白屏：
 *  - root 形态（全屏）：默认带 stack，定位"整站崩溃"类问题
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
    // 本地日志 + 远程埋点（同一事件，不丢任何一种）
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
      // root 边界默认 UI
      return (
        <div className="min-h-screen flex flex-col items-center justify-center px-6 gap-3 bg-background">
          <div className="text-[15px] font-medium text-foreground">页面渲染出错</div>
          <div className="text-[12px] text-destructive break-all max-w-lg text-center leading-relaxed">
            {error.message || String(error)}
          </div>
          {error.stack && (
            <pre className="text-[10.5px] text-muted-foreground/70 whitespace-pre-wrap break-all max-w-xl max-h-48 overflow-y-auto border border-border rounded-md p-2.5 bg-muted/30">
              {error.stack}
            </pre>
          )}
          <div className="flex gap-2">
            <button type="button" onClick={this.handleReset} className="btn-primary-custom">
              重试
            </button>
            <button
              type="button"
              onClick={() => { window.location.href = '/' }}
              className="btn-ghost-custom"
            >
              返回首页
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}