import { Component, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/**
 * 全局错误边界：任何组件渲染/生命周期抛错都不再白屏，
 * 而是展示具体错误（message + stack）+ 重新加载入口。
 * 定位「特定文档白屏」类问题也靠它——错误直接可见。
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error): void {
    console.error('[ErrorBoundary]', error)
  }

  handleReset = (): void => {
    this.setState({ error: null })
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="min-h-screen flex flex-col items-center justify-center px-6 gap-3 bg-background">
          <div className="text-[15px] font-medium text-foreground">页面渲染出错</div>
          <div className="text-[12px] text-destructive break-all max-w-lg text-center leading-relaxed">
            {this.state.error.message || String(this.state.error)}
          </div>
          {this.state.error.stack && (
            <pre className="text-[10.5px] text-muted-foreground/70 whitespace-pre-wrap break-all max-w-xl max-h-48 overflow-y-auto border border-border rounded-md p-2.5 bg-muted/30">
              {this.state.error.stack}
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
