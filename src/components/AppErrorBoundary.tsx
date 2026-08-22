import { Component, type ReactNode } from 'react'

interface AppErrorBoundaryProps {
  children: ReactNode
}

interface AppErrorBoundaryState {
  hasError: boolean
}

export class AppErrorBoundary extends Component<
  AppErrorBoundaryProps,
  AppErrorBoundaryState
> {
  constructor(props: AppErrorBoundaryProps) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { hasError: true }
  }

  private readonly handleRetry = () => {
    this.setState({ hasError: false })
  }

  override render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-full items-center justify-center bg-background p-6 font-sans">
          <section
            role="alert"
            aria-labelledby="app-error-title"
            className="w-full max-w-md rounded-lg border border-border bg-surface p-6 text-center shadow-card"
          >
            <h1
              id="app-error-title"
              className="text-module font-semibold text-foreground"
            >
              应用出现问题
            </h1>
            <p className="mt-2 text-body text-foreground-secondary">
              当前内容暂时无法显示。你可以重试。
            </p>
            <button
              type="button"
              className="mt-6 h-9 rounded-[9px] border border-transparent bg-primary px-3.5 text-body font-medium text-on-primary transition-colors duration-[140ms] outline-none hover:bg-primary-hover focus-visible:border-[var(--focus-color)] focus-visible:[box-shadow:var(--focus-ring)] active:bg-primary-pressed"
              onClick={this.handleRetry}
            >
              重试
            </button>
          </section>
        </div>
      )
    }

    return this.props.children
  }
}
