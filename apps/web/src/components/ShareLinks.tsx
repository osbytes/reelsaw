import { useMemo, useState } from "react";
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTRPC } from "../lib/trpc";
import { useLoadMoreSentinel } from "../lib/useLoadMore";
import { ConfirmDialog, Modal, Segmented, Skeleton, SkeletonRegion } from "./ui";

type LinkInput =
  | { kind: "clip" | "thumb" | "srt" | "vtt"; clipId: string; ttlDays?: number | null; label?: string }
  | { kind: "export"; projectId: string; clipIds?: string[]; ttlDays?: number | null; label?: string };

const PAGE = 50;

function day(d: Date | string | null | undefined) {
  if (!d) return null;
  return new Date(d).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** "until 29 Jan 2027" / "with no expiry" */
const until = (d: Date | string | null) => (d ? `until ${day(d)}` : "with no expiry");

/**
 * Copy a share link (docs/specs/media-links.md): the clip's active link, or a new one. The clipboard write is started
 * inside the click (a promised ClipboardItem), so Safari keeps the user gesture while the link is fetched.
 */
export function useCopyShareLink() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const get = useMutation(trpc.mediaLinks.get.mutationOptions());
  return (input: LinkInput, what = "this clip") => {
    const link = get.mutateAsync(input);
    const text = link.then((l) => l.url);
    const write =
      typeof ClipboardItem !== "undefined" && navigator.clipboard?.write
        ? navigator.clipboard.write([new ClipboardItem({ "text/plain": text.then((t) => new Blob([t], { type: "text/plain" })) })])
        : text.then((t) => navigator.clipboard.writeText(t));
    Promise.all([link, write])
      .then(([l]) => {
        toast(`Share link copied. Anyone with it can download ${what} ${until(l.expiresAt)}.`);
        void qc.invalidateQueries({ queryKey: trpc.mediaLinks.list.pathKey() });
      })
      .catch((e: unknown) => toast.error(e instanceof Error ? e.message : "Couldn’t copy the link"));
  };
}

/** Expiry, label and a separate link: for "a link for Buffer I can revoke on its own". */
export function ShareLinkDialog({ open, onOpenChange, target, what }: { open: boolean; onOpenChange: (o: boolean) => void; target: LinkInput; what: string }) {
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
  const options = [
    ...[7, 30, 90].filter((d) => d < max).map((d) => ({ value: String(d), label: `${d} days` })),
    { value: "default", label: `${max} days` },
    ...(policy.data?.allowNever ? [{ value: "never", label: "Never" }] : []),
  ];
  const l = create.data;
  return (
    <Modal
      open={open}
      onOpenChange={(o) => {
        if (!o) create.reset();
        onOpenChange(o);
      }}
      title="Share link"
      width={460}
    >
      <p className="text-[13px] text-ink2">
        Anyone with the link can download {what} without signing in, until it expires or you revoke it. It always serves the latest render.
      </p>
      <div className="flex flex-col gap-1">
        <span className="text-xs font-semibold text-ink2">Expires after</span>
        <Segmented size="sm" ariaLabel="Link expiry" value={ttl} options={options} onChange={setTtl} />
      </div>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-semibold text-ink2">Label (optional, makes a separate link)</span>
        <input className="input" placeholder="e.g. Buffer queue" value={label} maxLength={120} onChange={(e) => setLabel(e.target.value)} />
      </label>
      {/* reserved: the link appears here, nothing moves */}
      <div className="flex min-h-[2.25rem] items-center gap-2">
        {l ? (
          <>
            <code className="min-w-0 flex-1 truncate rounded-[8px] bg-sunk px-2 py-1 font-mono text-xs">{l.url}</code>
            <button className="btn-ghost text-xs" onClick={() => void navigator.clipboard.writeText(l.url).then(() => toast("Link copied"))}>
              Copy
            </button>
          </>
        ) : (
          <span className="text-xs text-ink3">
            {policy.data ? `Links on this instance last at most ${max} days${policy.data.allowNever ? " unless set to never" : ""}.` : ""}
          </span>
        )}
      </div>
      <div className="flex justify-end gap-2">
        <button className="btn-quiet" onClick={() => onOpenChange(false)}>
          {l ? "Done" : "Cancel"}
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
          {create.isPending ? "Creating…" : l ? "Create another" : "Create link"}
        </button>
      </div>
    </Modal>
  );
}

const KIND_LABEL = { clip: "Video", thumb: "Thumbnail", srt: "Captions (SRT)", vtt: "Captions (VTT)", export: "Zip" } as const;
const SOURCE_LABEL = { ui: "you", mcp: "MCP", cli: "CLI", webhook: "webhook" } as const;
const STATE = {
  active: { glyph: "●", word: "Active", cls: "text-ok" },
  expired: { glyph: "○", word: "Expired", cls: "text-ink3" },
  revoked: { glyph: "✕", word: "Revoked", cls: "text-ink3" },
} as const;

/** Settings → Share links: every link of the account, what it points at, its expiry and use, with Copy and Revoke. */
export function ShareLinksSection() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [confirmAll, setConfirmAll] = useState(false);
  const list = useInfiniteQuery(
    trpc.mediaLinks.list.infiniteQueryOptions({ limit: PAGE }, { getNextPageParam: (last) => last.nextCursor ?? undefined, placeholderData: keepPreviousData }),
  );
  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const total = list.data?.pages[0]?.total ?? 0;
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
  const active = items.filter((i) => i.state === "active").length;

  return (
    <section className="flex flex-col gap-3 rounded-[16px] border border-line bg-panel p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[15px] font-bold">Share links</h2>
        <button className="btn-danger min-w-[10rem] text-xs" disabled={!active || revoke.isPending} onClick={() => setConfirmAll(true)}>
          Revoke all share links
        </button>
      </div>
      <p className="text-[13px] text-ink2">
        Links that download a clip, its captions or a project’s zip without signing in, for schedulers (Buffer, Metricool), Instagram, Zapier or a person. Copy
        one from a clip’s ⋯ menu; webhooks include them too.
      </p>
      <div className="min-h-6 text-[13px]">
        {list.isPending && !list.error && (
          <SkeletonRegion label="Loading share links…" className="divide-y divide-line">
            {["w-1/3", "w-1/4", "w-2/5"].map((w, i) => (
              <div key={i} className="flex items-center gap-3 py-2">
                <Skeleton className={`h-4 ${w}`} />
                <Skeleton className="ml-auto h-3.5 w-28" />
                <Skeleton className="h-7 w-32 rounded-[8px]" />
              </div>
            ))}
          </SkeletonRegion>
        )}
        {list.error && <span className="text-err">✕ {list.error.message}</span>}
        {list.data && items.length === 0 && <span className="text-ink3">No share links yet. Copy one from a clip’s menu.</span>}
        {items.length > 0 && (
          <>
            <ul className="divide-y divide-line">
              <li aria-hidden className="hidden grid-cols-[minmax(0,1fr)_6.5rem_7.5rem_4rem_9.5rem] items-center gap-x-3 pb-1 text-xs text-ink3 md:grid">
                <span>Link</span>
                <span>Status</span>
                <span>Expires</span>
                <span className="text-right">Uses</span>
                <span />
              </li>
              {items.map((l) => (
                <li
                  key={l.id}
                  className="grid min-h-[3.25rem] grid-cols-[minmax(0,1fr)_9.5rem] items-center gap-x-3 py-2 md:grid-cols-[minmax(0,1fr)_6.5rem_7.5rem_4rem_9.5rem]"
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-semibold">
                      {l.clipTitle ?? l.projectTitle}
                      {l.label ? (
                        <span className="ml-2 rounded-[6px] bg-sunk px-1.5 py-0.5 align-middle text-[11px] font-normal text-ink2">{l.label}</span>
                      ) : null}
                    </span>
                    <span className="truncate text-xs text-ink3">
                      {KIND_LABEL[l.kind]} · by {SOURCE_LABEL[l.source]}
                      {l.lastUsedAt ? ` · last used ${day(l.lastUsedAt)}` : " · not used yet"}
                      <span className="md:hidden">
                        {" "}
                        · {STATE[l.state].word.toLowerCase()} · {l.useCount} use{l.useCount === 1 ? "" : "s"}
                      </span>
                    </span>
                  </span>
                  <span className={`hidden text-xs md:block ${STATE[l.state].cls}`}>
                    {STATE[l.state].glyph} <span className="text-ink2">{STATE[l.state].word}</span>
                  </span>
                  <span className="hidden text-xs text-ink2 md:block">{l.revokedAt ? `revoked ${day(l.revokedAt)}` : (day(l.expiresAt) ?? "never")}</span>
                  <span className="hidden text-right text-xs tabular-nums text-ink2 md:block">{l.useCount}</span>
                  <span className="flex justify-end gap-1.5">
                    <button
                      className="btn-ghost w-[4.25rem] text-xs"
                      disabled={l.state !== "active"}
                      title={l.state === "active" ? "Copy the link" : "This link no longer works"}
                      onClick={() => void navigator.clipboard.writeText(l.url).then(() => toast("Link copied"))}
                    >
                      Copy
                    </button>
                    <button
                      className="btn-danger w-[4.5rem] text-xs"
                      disabled={l.state !== "active" || revoke.isPending}
                      title={l.state === "active" ? "Turn this link off now" : "Already off"}
                      onClick={() => revoke.mutate({ linkId: l.id })}
                    >
                      Revoke
                    </button>
                  </span>
                </li>
              ))}
            </ul>
            <div className="flex h-8 items-center text-xs text-ink3">
              Showing {items.length} of {total}
            </div>
            <div ref={more} />
          </>
        )}
      </div>
      <ConfirmDialog
        open={confirmAll}
        onOpenChange={setConfirmAll}
        title="Revoke all share links?"
        body="Every share link you or your webhooks handed out stops working now: queued scheduler posts and links you sent people included. New links can be copied again."
        confirm="Revoke all"
        danger
        onConfirm={() => {
          revoke.mutate({ all: true });
          setConfirmAll(false);
        }}
      />
    </section>
  );
}
