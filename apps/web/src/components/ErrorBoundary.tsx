import { Component, type ReactNode } from "react";

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error("[ui] render error", error);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="card m-6 p-6">
        <h2 className="mb-2 text-sm font-semibold text-err">Something went wrong rendering this page</h2>
        <pre className="mb-4 whitespace-pre-wrap font-mono text-xs text-ink3">{this.state.error.message}</pre>
        <button className="btn-ghost" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    );
  }
}
