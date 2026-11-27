import { Component, type ErrorInfo, type ReactNode } from 'react';

type ErrorBoundaryProps = {
  children: ReactNode;
  resetKey?: string;
};

type ErrorBoundaryState = {
  hasError: boolean;
};

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidUpdate(prevProps: ErrorBoundaryProps): void {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ hasError: false });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('页面渲染异常:', error, info.componentStack);
  }

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div className="mx-auto flex min-h-[60vh] max-w-[1280px] items-center justify-center px-6 py-16">
        <section
          role="alert"
          className="w-full max-w-[480px] rounded-[20px] bg-surface p-8 text-left"
        >
          <h1 tabIndex={-1} className="text-[22px] font-medium tracking-[-0.02em] text-ink">
            这一页暂时没能顺利打开
          </h1>
          <p className="mt-3 text-[15px] text-ink-muted">
            可以刷新重试，或先回到首页看看别的记录。
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <button
              type="button"
              className="pill-cta-primary"
              onClick={() => this.setState({ hasError: false })}
            >
              重试
            </button>
            <a href="/" className="pill-cta-secondary">
              返回首页
            </a>
          </div>
        </section>
      </div>
    );
  }
}
