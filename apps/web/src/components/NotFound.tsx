/** Page-level empty state for a missing or unloadable project / clip: says what happened and where to go. */
import { Link } from "react-router";
import { Trans, useLingui } from "@lingui/react/macro";

interface Props {
  what: "project" | "clip";
  /** the query error, if any: NOT_FOUND reads as "gone or not yours", anything else as a load failure */
  error?: { message?: string; data?: { code?: string } | null | undefined } | null;
  onRetry?: () => void;
}

export function NotFound({ what, error, onRetry }: Props) {
  const code = error?.data?.code ?? (error?.message === "NOT_FOUND" ? "NOT_FOUND" : undefined);
  const missing = !error || code === "NOT_FOUND";
  const { t } = useLingui();
  const title =
    what === "project"
      ? missing
        ? t`This project doesn’t exist`
        : t`Couldn’t load this project`
      : missing
        ? t`This clip doesn’t exist`
        : t`Couldn’t load this clip`;
  const gone =
    what === "project"
      ? t`It may have been deleted, or it belongs to another account. Links only open projects of the account you’re signed in to.`
      : t`It may have been deleted, or it belongs to another account. Links only open clips of the account you’re signed in to.`;
  return (
    <div className="flex min-h-0 flex-1 items-start justify-center px-5 py-16">
      <div role={missing ? undefined : "alert"} className="flex w-full max-w-[460px] flex-col items-center gap-3 text-center">
        <span className="font-mono text-2xl leading-8 text-ink3" aria-hidden>
          {missing ? "∅" : "▲"}
        </span>
        <b className="text-lg">{title}</b>
        <p className="text-[13px] leading-relaxed text-ink2">{missing ? gone : (error?.message ?? t`Something went wrong talking to the server.`)}</p>
        <div className="mt-1 flex gap-2">
          <Link to="/" className="btn-primary py-2 no-underline">
            <Trans>Back to projects</Trans>
          </Link>
          {!missing && onRetry && (
            <button className="btn-ghost py-2" onClick={onRetry}>
              <Trans>Try again</Trans>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
