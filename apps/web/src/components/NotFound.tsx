/** Page-level empty state for a missing or unloadable project / clip: says what happened and where to go. */
import { Link } from "react-router";

interface Props {
  what: "project" | "clip";
  /** the query error, if any: NOT_FOUND reads as "gone or not yours", anything else as a load failure */
  error?: { message?: string; data?: { code?: string } | null } | null;
  onRetry?: () => void;
}

export function NotFound({ what, error, onRetry }: Props) {
  const code = error?.data?.code ?? (error?.message === "NOT_FOUND" ? "NOT_FOUND" : undefined);
  const missing = !error || code === "NOT_FOUND";
  return (
    <div className="flex min-h-0 flex-1 items-start justify-center px-5 py-16">
      <div role={missing ? undefined : "alert"} className="flex w-full max-w-[460px] flex-col items-center gap-3 text-center">
        <span className="font-mono text-2xl leading-8 text-ink3" aria-hidden>
          {missing ? "∅" : "▲"}
        </span>
        <b className="text-lg">{missing ? `This ${what} doesn’t exist` : `Couldn’t load this ${what}`}</b>
        <p className="text-[13px] leading-relaxed text-ink2">
          {missing ? `It may have been deleted, or it belongs to another account. Links only open ${what}s of the account you’re signed in to.` : (error?.message ?? "Something went wrong talking to the server.")}
        </p>
        <div className="mt-1 flex gap-2">
          <Link to="/" className="btn-primary py-2 no-underline">
            Back to projects
          </Link>
          {!missing && onRetry && (
            <button className="btn-ghost py-2" onClick={onRetry}>
              Try again
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
