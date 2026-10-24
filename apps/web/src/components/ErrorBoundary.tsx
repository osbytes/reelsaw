import { Component, type ReactNode } from "react";
import { reportClientError } from "../lib/diagnostics";
import { handleStaleChunk, isStaleChunkError, refreshForNewVersion, staleChunkReloadInFlight } from "../lib/stale-chunk";
import { captureException } from "../lib/telemetry";

export class ErrorBoundary extends Component<{ children: ReactNode; quiet?: boolean }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    if (isStaleChunkError(error)) {
      handleStaleChunk();
      return;
    }
    reportClientError("render", error, { send: true });
    captureException(error, { where: "render" });
  }
  render() {
    if (!this.state.error) return this.props.children;
    if (isStaleChunkError(this.state.error)) {
      if (staleChunkReloadInFlight()) return null;
      if (this.props.quiet) return null;
      return (
        <div className="card m-6 p-6">
          <h2 className="mb-2 text-sm font-semibold text-ink">This page is from an older version</h2>
          <p className="mb-4 text-sm text-ink2">Save any unsaved edits, then refresh to load it.</p>
          <button className="btn-primary" type="button" onClick={refreshForNewVersion}>
            Refresh
          </button>
        </div>
      );
    }
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
