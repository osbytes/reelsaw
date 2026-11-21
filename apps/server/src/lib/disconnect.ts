/**
 * Whether reading a request body failed because the client went away (a closed tab, a dropped connection, a cancel):
 * Node rejects the stream with "aborted" (code ECONNRESET), or a pipeline reports a premature close. That is the
 * client's network, not a fault of ours: callers log it as a warning, and nobody gets an error report for it.
 */
export function isClientDisconnect(err: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  return code === "ECONNRESET" || code === "ERR_STREAM_PREMATURE_CLOSE" || (err.message === "aborted" && code === undefined);
}
