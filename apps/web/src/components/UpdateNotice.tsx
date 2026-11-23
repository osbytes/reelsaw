import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Trans, useLingui } from "@lingui/react/macro";
import { CHANGELOG_URL } from "@reelsaw/shared";
import { useTRPC } from "../lib/trpc";
import { useMe } from "../lib/account";
import { ago } from "../lib/time";
import { Notice } from "./ui";

/**
 * Is a newer Reelsaw published? Admins only; the server checks every few hours (updates.ts), so this
 * refetches slowly, and quickly only while a check is in flight.
 */
export function useUpdateStatus() {
  const trpc = useTRPC();
  const me = useMe();
  const isAdmin = me.data?.role === "admin";
  return useQuery({
    ...trpc.admin.updates.get.queryOptions(),
    enabled: isAdmin,
    staleTime: 60_000,
    refetchInterval: (q) => (q.state.data?.checking ? 2000 : 10 * 60_000),
  });
}

/** Top bar: a dot on the account button while an update is available (admins); the menu says what. */
export function UpdateDot() {
  const { t } = useLingui();
  const u = useUpdateStatus().data;
  if (!u?.available || !u.latest) return null;
  return (
    <span
      className="absolute -top-0.5 -end-0.5 h-2.5 w-2.5 rounded-full bg-acc ring-2 ring-panel"
      role="img"
      aria-label={t`Reelsaw ${u.latest.version} is available`}
    />
  );
}

/** Account menu, next to "Settings": the version waiting (admins). */
export function UpdateMenuHint() {
  const u = useUpdateStatus().data;
  if (!u?.available || !u.latest) return null;
  return <span className="ms-auto ps-3 font-mono text-[11px] text-acc-text">↑ {u.latest.version}</span>;
}

/** Settings → System heading: the running version with the update state and a "Check now". */
export function UpdateStatusLine({ version }: { version: string | null }) {
  const { t } = useLingui();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const q = useUpdateStatus();
  const u = q.data;
  const check = useMutation(
    trpc.admin.updates.check.mutationOptions({
      onSuccess: (st) => {
        qc.setQueryData(trpc.admin.updates.get.queryKey(), st);
        const err = st.error;
        const latest = st.latest?.version;
        toast(
          err
            ? t`Could not check: ${err}`
            : st.available
              ? t`Reelsaw ${latest} is available`
              : st.available === false
                ? t`Up to date`
                : t`Latest release: ${latest}`,
        );
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const busy = check.isPending || !!u?.checking;
  let word = "";
  if (u) {
    if (!u.enabled) word = t`update checks off`;
    else if (u.checking && !u.latest) word = t`checking for updates…`;
    else if (u.available) word = t`update available`;
    else if (u.available === false) word = u.checkedAt ? t`up to date · checked ${ago(u.checkedAt)}` : t`up to date`;
    else if (u.latest) word = t`latest release ${u.latest.version}`;
    else if (u.error) word = t`update check failed: ${u.error}`;
  }
  return (
    <span className="flex min-h-5 min-w-0 flex-wrap items-baseline gap-x-2 font-mono text-xs text-ink3">
      {version && <span>{version}</span>}
      {word && (
        <span className={u?.available ? "text-acc-text" : ""} title={u?.error && u.latest ? t`Last check failed: ${u.error}` : undefined}>
          · {word}
        </span>
      )}
      {u?.enabled && (
        <button type="button" className="btn-quiet h-5 px-1.5 py-0 font-sans text-xs" disabled={busy} onClick={() => check.mutate()}>
          {busy ? t`Checking…` : t`Check now`}
        </button>
      )}
    </span>
  );
}

/** Settings → System: what is new and the one step to get it; nothing while up to date. */
export function UpdateBanner() {
  const { t } = useLingui();
  const u = useUpdateStatus().data;
  if (!u?.available || !u.latest) return null;
  const copy = () => void navigator.clipboard.writeText(u.upgrade.command).then(() => toast(t`Command copied`));
  return (
    <Notice tone="acc" glyph="↑">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <b>
          <Trans>Reelsaw {u.latest.version} is available</Trans>
        </b>
        <span className="text-ink2">
          <Trans>you run {u.current}</Trans>
        </span>
        <a
          href={`${CHANGELOG_URL}#${u.latest.version.startsWith("v") ? u.latest.version : `v${u.latest.version}`}`}
          target="_blank"
          rel="noreferrer"
          className="text-acc-text"
        >
          <Trans>What's new</Trans>
        </a>
        <a href={u.latest.url} target="_blank" rel="noreferrer" className="text-acc-text">
          <Trans>GitHub ↗</Trans>
        </a>
      </div>
      <p className="mt-1 text-ink2">{u.upgrade.note}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <code className="rounded-[8px] bg-panel px-2 py-1 font-mono text-xs">{u.upgrade.command}</code>
        <button type="button" className="btn-ghost h-7 px-2 py-0 text-xs" onClick={copy}>
          <Trans>Copy</Trans>
        </button>
        <a href={u.upgrade.docsUrl} target="_blank" rel="noreferrer" className="text-xs text-ink2">
          <Trans>Upgrade guide ↗</Trans>
        </a>
      </div>
    </Notice>
  );
}
