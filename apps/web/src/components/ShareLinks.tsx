import { useMemo, useState } from "react";
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { MessageDescriptor } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { toast } from "sonner";
import { copyText, showTextToCopy } from "../lib/clipboard";
import { useTRPC } from "../lib/trpc";
import { useLoadMoreSentinel } from "../lib/useLoadMore";
import { ScrollArea, SECTION_LIST_MAX_H } from "./scroll-area";
import { ConfirmDialog, Modal, Segmented, Skeleton, SkeletonRegion } from "./ui";
import { formatDay, formatNumber } from "@reelsaw/shared";

type LinkInput =
  | { kind: "clip" | "thumb" | "srt" | "vtt"; clipId: string; ttlDays?: number | null; label?: string }
  | { kind: "export"; projectId: string; clipIds?: string[]; ttlDays?: number | null; label?: string };

const PAGE = 50;

/**
 * Copy a share link (docs/specs/media-links.md): the clip's active link, or a new one. The clipboard write is started
 * inside the click (a promised ClipboardItem), so Safari keeps the user gesture while the link is fetched. A refused
 * clipboard still shows the link (it exists by then), so the person never loses it to an error.
 */
export function useCopyShareLink() {
  const { t } = useLingui();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const get = useMutation(trpc.mediaLinks.get.mutationOptions());
  /** "until 29 Jan 2027" / "with no expiry" */
  const until = (d: Date | string | null) => {
    if (!d) return t`with no expiry`;
    const day = formatDay(d, { month: "short" });
    return t`until ${day}`;
  };
  return (input: LinkInput, what = t`this clip`) => {
    const link = get.mutateAsync(input);
    const text = link.then((l) => l.url);
    const write =
      typeof ClipboardItem !== "undefined" && navigator.clipboard?.write
        ? navigator.clipboard.write([new ClipboardItem({ "text/plain": text.then((u) => new Blob([u], { type: "text/plain" })) })])
        : text.then((u) => navigator.clipboard.writeText(u));
    // settled below; without this a failed lookup would also surface as an unhandled rejection of the write
    write.catch(() => {});
    link
      .then(async (l) => {
        void qc.invalidateQueries({ queryKey: trpc.mediaLinks.list.pathKey() });
        const expiry = until(l.expiresAt);
        try {
          await write;
          toast(t`Share link copied. Anyone with it can download ${what} ${expiry}.`);
        } catch {
          showTextToCopy(l.url, t`Share link made (${expiry}), but your browser didn’t allow copying.`);
        }
      })
      .catch((e: unknown) => toast.error(e instanceof Error ? e.message : t`Couldn’t make the link`));
  };
}

/** Expiry, label and a separate link: for "a link for Buffer I can revoke on its own". */
export function ShareLinkDialog({ open, onOpenChange, target, what }: { open: boolean; onOpenChange: (o: boolean) => void; target: LinkInput; what: string }) {
  const { t } = useLingui();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const policy = useQuery({ ...trpc.mediaLinks.policy.queryOptions(), enabled: open });
  const [ttl, setTtl] = useState<string>("default");
  const [label, setLabel] = useState("");
  const create = useMutation(
    trpc.mediaLinks.get.mutationOptions({
      onSuccess: () => void qc.invalidateQueries({ queryKey: trpc.mediaLinks.list.pathKey() }),
      onError: (e) => toast.error(e.message),
    }),
  );
  const max = policy.data?.maxDays ?? 90;
  const days = (d: number) => plural(d, { one: "# day", other: "# days" });
  const options = [
    ...[7, 30, 90].filter((d) => d < max).map((d) => ({ value: String(d), label: days(d) })),
    { value: "default", label: days(max) },
    ...(policy.data?.allowNever ? [{ value: "never", label: t`Never` }] : []),
  ];
  const l = create.data;
  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (!o) create.reset();
        onOpenChange(o);
      }}
      title={t`Share link`}
      width={460}
    >
      <p className="text-[13px] text-ink2">
        <Trans>Anyone with the link can download {what} without signing in, until it expires or you revoke it. It always serves the latest render.</Trans>
      </p>
      <div className="flex flex-col gap-1">
        <span className="text-xs font-semibold text-ink2">
          <Trans>Expires after</Trans>
        </span>
        <Segmented size="sm" ariaLabel={t`Link expiry`} value={ttl} options={options} onChange={setTtl} />
      </div>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-semibold text-ink2">
          <Trans>Label (optional, makes a separate link)</Trans>
        </span>
        <input className="input" placeholder={t`e.g. Buffer queue`} value={label} maxLength={120} onChange={(e) => setLabel(e.target.value)} />
      </label>
      {/* reserved: the link appears here, nothing moves */}
      <div className="flex min-h-[2.25rem] items-center gap-2">
        {l ? (
          <>
            <code className="min-w-0 flex-1 truncate rounded-[8px] bg-sunk px-2 py-1 font-mono text-xs">{l.url}</code>
            <button className="btn-ghost text-xs" onClick={() => copyText(l.url, t`Link copied`)}>
              <Trans>Copy</Trans>
            </button>
          </>
        ) : (
          <span className="text-xs text-ink3">
            {policy.data ? (
              policy.data.allowNever ? (
                <Plural
                  value={max}
                  one="Links on this instance last at most # day unless set to never."
                  other="Links on this instance last at most # days unless set to never."
                />
              ) : (
                <Plural value={max} one="Links on this instance last at most # day." other="Links on this instance last at most # days." />
              )
            ) : (
              ""
            )}
          </span>
        )}
      </div>
      <div className="flex justify-end gap-2">
        <button className="btn-quiet" onClick={() => onOpenChange(false)}>
          {l ? <Trans>Done</Trans> : <Trans>Cancel</Trans>}
        </button>
        <button
          className="btn-ink min-w-[7.5rem]"
          disabled={create.isPending}
          onClick={() =>
            create.mutate({
              ...target,
              ...(ttl === "never" ? { ttlDays: null } : ttl === "default" ? {} : { ttlDays: Number(ttl) }),
              ...(label.trim() ? { label: label.trim() } : {}),
            })
          }
        >
          {create.isPending ? <Trans>Creating…</Trans> : l ? <Trans>Create another</Trans> : <Trans>Create link</Trans>}
        </button>
      </div>
    </Modal>
  );
}

const KIND_LABEL: Record<"clip" | "thumb" | "srt" | "vtt" | "export", MessageDescriptor> = {
  clip: msg`Video`,
  thumb: msg`Thumbnail`,
  srt: msg`Captions (SRT)`,
  vtt: msg`Captions (VTT)`,
  export: msg`Zip`,
};
const SOURCE_LABEL: Record<"ui" | "mcp" | "cli" | "webhook", MessageDescriptor> = { ui: msg`you`, mcp: msg`MCP`, cli: msg`CLI`, webhook: msg`webhook` };
const STATE = {
  active: { glyph: "●", word: msg`Active`, lower: msg`active`, cls: "text-ok" },
  expired: { glyph: "○", word: msg`Expired`, lower: msg`expired`, cls: "text-ink3" },
  revoked: { glyph: "✕", word: msg`Revoked`, lower: msg`revoked`, cls: "text-ink3" },
  trashed: { glyph: "◌", word: msg`In trash`, lower: msg`in trash`, cls: "text-ink3" },
} as const;

/**
 * Settings → Share links: every link of the account, what it points at, its expiry and use, with Copy and Revoke. The
 * list scrolls inside the card; Clear deletes the revoked and expired rows (the pruner would after a retention window).
 */
export function ShareLinksSection() {
  const { t } = useLingui();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [confirmAll, setConfirmAll] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [confirmOne, setConfirmOne] = useState<{ id: string; title: string } | null>(null);
  const list = useInfiniteQuery(
    trpc.mediaLinks.list.infiniteQueryOptions({ limit: PAGE }, { getNextPageParam: (last) => last.nextCursor ?? undefined, placeholderData: keepPreviousData }),
  );
  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const total = list.data?.pages[0]?.total ?? 0;
  const stopped = list.data?.pages[0]?.stopped ?? 0;
  const more = useLoadMoreSentinel(() => void list.fetchNextPage(), !!list.hasNextPage && !list.isFetching);
  const revoke = useMutation(
    trpc.mediaLinks.revoke.mutationOptions({
      onSuccess: (r) => {
        toast(r.message);
        void qc.invalidateQueries({ queryKey: trpc.mediaLinks.list.pathKey() });
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const clear = useMutation(
    trpc.mediaLinks.clear.mutationOptions({
      onSuccess: (r) => {
        toast(r.message);
        void qc.invalidateQueries({ queryKey: trpc.mediaLinks.list.pathKey() });
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const active = items.filter((i) => i.state === "active").length;
  const shown = formatNumber(items.length);
  const oneTitle = confirmOne?.title ?? t`this file`;

  return (
    <section className="flex flex-col gap-3 rounded-[16px] border border-line bg-panel p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[15px] font-bold">
          <Trans>Share links</Trans>
        </h2>
        {/* kept in place but hidden while there is nothing to act on, so the header does not move when links appear; on a
            phone, where the buttons wrap below the title anyway, a hidden Clear takes no room instead of leaving a gap */}
        <span className="flex flex-wrap gap-2">
          <button
            className={`btn-ghost min-w-[8.5rem] text-xs ${stopped ? "" : "invisible max-sm:hidden"}`}
            aria-hidden={!stopped}
            tabIndex={stopped ? undefined : -1}
            disabled={!stopped || clear.isPending}
            title={t`Delete revoked and expired links from this list`}
            onClick={() => setConfirmClear(true)}
          >
            {stopped ? <Trans>Clear {stopped} stopped</Trans> : <Trans>Clear stopped</Trans>}
          </button>
          <button
            className={`btn-danger min-w-[10rem] text-xs ${active ? "" : "invisible"}`}
            aria-hidden={!active}
            tabIndex={active ? undefined : -1}
            disabled={!active || revoke.isPending}
            onClick={() => setConfirmAll(true)}
          >
            <Trans>Revoke all share links</Trans>
          </button>
        </span>
      </div>
      <p className="text-[13px] text-ink2">
        <Trans>
          Links that download a clip, its captions or a project’s zip without signing in, for schedulers (Buffer, Metricool), Instagram, Zapier or a person.
          Copy one from a clip’s ⋯ menu; webhooks include them too.
        </Trans>
      </p>
      <div className="min-h-6 text-[13px]">
        {list.isPending && !list.error && (
          <SkeletonRegion label={t`Loading share links…`} className="divide-y divide-line">
            {["w-1/3", "w-1/4", "w-2/5"].map((w, i) => (
              <div key={i} className="flex items-center gap-3 py-2">
                <Skeleton className={`h-4 ${w}`} />
                <Skeleton className="ms-auto h-3.5 w-28" />
                <Skeleton className="h-7 w-32 rounded-[8px]" />
              </div>
            ))}
          </SkeletonRegion>
        )}
        {list.error && <span className="text-err">✕ {list.error.message}</span>}
        {list.data && items.length === 0 && (
          <span className="text-ink3">
            <Trans>No share links yet. Copy one from a clip’s menu.</Trans>
          </span>
        )}
        {items.length > 0 && (
          <>
            <ScrollArea className={SECTION_LIST_MAX_H}>
              <ul className="divide-y divide-line">
                <li
                  aria-hidden
                  className="sticky top-0 z-[1] hidden grid-cols-[minmax(0,1fr)_6.5rem_7.5rem_4rem_9.5rem] items-center gap-x-3 bg-panel pb-1 text-xs text-ink3 md:grid"
                >
                  <span>
                    <Trans>Link</Trans>
                  </span>
                  <span>
                    <Trans>Status</Trans>
                  </span>
                  <span>
                    <Trans>Expires</Trans>
                  </span>
                  <span className="text-end">
                    <Trans>Uses</Trans>
                  </span>
                  <span />
                </li>
                {items.map((l) => {
                  const kind = t(KIND_LABEL[l.kind]);
                  const by = t(SOURCE_LABEL[l.source]);
                  const lastUsed = l.lastUsedAt ? formatDay(l.lastUsedAt, { month: "short" }) : "";
                  const expires = l.expiresAt ? formatDay(l.expiresAt, { month: "short" }) : "";
                  const revoked = l.revokedAt ? formatDay(l.revokedAt, { month: "short" }) : "";
                  return (
                    <li
                      key={l.id}
                      className="grid min-h-[3.25rem] grid-cols-[minmax(0,1fr)_9.5rem] items-center gap-x-3 py-2 md:grid-cols-[minmax(0,1fr)_6.5rem_7.5rem_4rem_9.5rem]"
                    >
                      <span className="flex min-w-0 flex-col">
                        <span className="flex min-w-0 items-center gap-2">
                          <span className="truncate font-semibold">{l.clipTitle ?? l.projectTitle}</span>
                          {l.label ? (
                            <span className="max-w-[45%] shrink-0 truncate rounded-[6px] bg-sunk px-1.5 py-0.5 text-[11px] text-ink2" title={l.label}>
                              {l.label}
                            </span>
                          ) : null}
                        </span>
                        <span className="text-xs text-ink3 md:truncate">
                          <Trans>
                            {kind} · by {by}
                          </Trans>
                          {l.lastUsedAt ? (
                            <>
                              {" · "}
                              <Trans>last used {lastUsed}</Trans>
                            </>
                          ) : (
                            <>
                              {" · "}
                              <Trans>not used yet</Trans>
                            </>
                          )}
                          <span className="md:hidden">
                            {" "}
                            · <span className={STATE[l.state].cls}>{t(STATE[l.state].lower)}</span>
                            {l.revokedAt ? (
                              ""
                            ) : l.expiresAt ? (
                              <>
                                {" "}
                                <Trans>until {expires}</Trans>
                              </>
                            ) : (
                              <Trans>, never expires</Trans>
                            )}{" "}
                            · <Plural value={l.useCount} one="# use" other="# uses" />
                          </span>
                        </span>
                      </span>
                      <span className={`hidden text-xs md:block ${STATE[l.state].cls}`}>
                        {STATE[l.state].glyph} <span className="text-ink2">{t(STATE[l.state].word)}</span>
                      </span>
                      <span className="hidden text-xs text-ink2 md:block">
                        {l.revokedAt ? <Trans>revoked {revoked}</Trans> : l.expiresAt ? expires : <Trans>never</Trans>}
                      </span>
                      <span className="hidden text-end text-xs tabular-nums text-ink2 md:block">{formatNumber(l.useCount)}</span>
                      <span className="flex justify-end gap-1.5">
                        <button
                          className="btn-ghost w-[4.25rem] text-xs"
                          disabled={l.state !== "active"}
                          title={
                            l.state === "active"
                              ? t`Copy the link`
                              : l.state === "trashed"
                                ? t`Restore its project to use this link again`
                                : t`This link no longer works`
                          }
                          onClick={() => copyText(l.url, t`Link copied`)}
                        >
                          <Trans>Copy</Trans>
                        </button>
                        <button
                          className="btn-danger w-[4.5rem] text-xs"
                          disabled={(l.state !== "active" && l.state !== "trashed") || revoke.isPending}
                          title={
                            l.state === "active"
                              ? t`Turn this link off now`
                              : l.state === "trashed"
                                ? t`Off while its project is in the trash; revoking keeps it off after a restore`
                                : t`Already off`
                          }
                          onClick={() => setConfirmOne({ id: l.id, title: l.clipTitle ?? l.projectTitle })}
                        >
                          <Trans>Revoke</Trans>
                        </button>
                      </span>
                    </li>
                  );
                })}
              </ul>
              {/* inside the scroll area, so the next page loads as the list (not the page) scrolls to its end */}
              <div ref={more} />
            </ScrollArea>
            <div className="flex h-8 items-center text-xs text-ink3">
              {items.length < total ? (
                <Plural value={total} one={`Showing ${shown} of # share link`} other={`Showing ${shown} of # share links`} />
              ) : (
                <Plural value={total} one="# share link" other="# share links" />
              )}
            </div>
          </>
        )}
      </div>
      <ConfirmDialog
        open={!!confirmOne}
        onOpenChange={(o) => !o && setConfirmOne(null)}
        title={t`Revoke this share link?`}
        body={t`The link to “${oneTitle}” stops working now, for queued scheduler posts and people you sent it to as well. It cannot be turned back on; copying a link again makes a new one.`}
        confirm={t`Revoke`}
        danger
        onConfirm={() => (confirmOne ? revoke.mutateAsync({ linkId: confirmOne.id }) : Promise.resolve())}
      />
      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title={t`Clear stopped share links?`}
        body={plural(stopped, {
          one: "Deletes # revoked or expired link from this list; they already don’t work. Active links and links of projects in the trash stay.",
          other: "Deletes # revoked or expired links from this list; they already don’t work. Active links and links of projects in the trash stay.",
        })}
        confirm={t`Clear`}
        onConfirm={() => clear.mutateAsync()}
      />
      <ConfirmDialog
        open={confirmAll}
        onOpenChange={setConfirmAll}
        title={t`Revoke all share links?`}
        body={t`Every share link you or your webhooks handed out stops working now: queued scheduler posts and links you sent people included. New links can be copied again.`}
        confirm={t`Revoke all`}
        danger
        onConfirm={() => revoke.mutateAsync({ all: true })}
      />
    </section>
  );
}
