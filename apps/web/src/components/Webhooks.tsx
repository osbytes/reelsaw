import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { toast } from "sonner";
import { useTRPC } from "../lib/trpc";
import { useLoadMoreSentinel } from "../lib/useLoadMore";
import { ConfirmDialog, Modal, MoreButton, Skeleton, SkeletonRegion } from "./ui";
import { ScrollArea } from "./scroll-area";

const EVENT_LABEL: Record<string, string> = {
  "project.created": "Project created",
  "project.done": "Project finished (every clip, share links, zip)",
  "project.failed": "Project failed",
  "clip.done": "Clip rendered (re-renders too)",
  "clip.failed": "Clip failed",
};
const STATUS = {
  active: { glyph: "●", word: "Active", cls: "text-ok" },
  failing: { glyph: "▲", word: "Failing", cls: "text-warn" },
  off: { glyph: "○", word: "Off", cls: "text-ink3" },
} as const;
const DELIVERY = {
  pending: { glyph: "◷", word: "Waiting", cls: "text-ink3" },
  sending: { glyph: "◷", word: "Sending", cls: "text-acc-text" },
  delivered: { glyph: "✓", word: "Delivered", cls: "text-ok" },
  failed: { glyph: "✕", word: "Failed", cls: "text-err" },
  cancelled: { glyph: "○", word: "Cancelled", cls: "text-ink3" },
} as const;

function when(d: Date | string | null | undefined) {
  if (!d) return "";
  return new Date(d).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** `#webhooks&webhook=whk_…`: the endpoint whose delivery log is open. */
function readHash(): string | null {
  const m = /(?:^#|&)webhook=([\w-]+)/.exec(window.location.hash);
  return m?.[1] ?? null;
}
function writeHash(id: string | null) {
  const next = id ? `#webhooks&webhook=${id}` : "#webhooks";
  if (window.location.hash !== next) window.history.replaceState(window.history.state, "", next);
}

type Endpoint = {
  id: string;
  url: string;
  urlMasked: string;
  description: string | null;
  events: string[];
  enabled: boolean;
  status: keyof typeof STATUS;
  disabledReason: string | null;
  failingSince: Date | string | null;
  secretStart: string;
  rotationEndsAt: Date | string | null;
  lastDelivery: { status: keyof typeof DELIVERY; code: number | null; at: Date | string; type: string } | null;
};

/** Add or edit: URL, label, events. A new endpoint's secret shows here once, in space kept for it. */
function EndpointDialog({ open, onOpenChange, edit }: { open: boolean; onOpenChange: (o: boolean) => void; edit: Endpoint | null }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const types = useQuery({ ...trpc.webhooks.eventTypes.queryOptions(), enabled: open });
  const [url, setUrl] = useState(edit?.url ?? "");
  const [description, setDescription] = useState(edit?.description ?? "");
  const [events, setEvents] = useState<string[]>(edit?.events ?? ["project.done"]);
  const [secret, setSecret] = useState<{ id: string; secret: string } | null>(null);
  const invalidate = () => void qc.invalidateQueries({ queryKey: trpc.webhooks.list.queryKey() });
  const create = useMutation(
    trpc.webhooks.create.mutationOptions({
      onSuccess: (r) => {
        setSecret({ id: r.endpoint.id, secret: r.secret });
        invalidate();
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const update = useMutation(
    trpc.webhooks.update.mutationOptions({
      onSuccess: (r) => {
        toast(r.message);
        invalidate();
        onOpenChange(false);
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const test = useMutation(
    trpc.webhooks.test.mutationOptions({
      onSuccess: (r) => {
        (r.ok ? toast : toast.error)(r.message);
        void qc.invalidateQueries({ queryKey: trpc.webhooks.pathKey() });
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  const pending = create.isPending || update.isPending;
  const valid = url.trim().length > 0 && events.length > 0;
  const save = () => {
    if (!valid) return;
    const typed = events.filter((e): e is "project.created" | "project.done" | "project.failed" | "clip.done" | "clip.failed" => e in EVENT_LABEL);
    if (edit) update.mutate({ id: edit.id, url: url.trim(), events: typed, description: description.trim() || null });
    else create.mutate({ url: url.trim(), events: typed, ...(description.trim() ? { description: description.trim() } : {}) });
  };
  return (
    <Modal open={open} onOpenChange={onOpenChange} title={edit ? "Edit webhook" : "Add webhook"} width={520}>
      {secret ? (
        <div className="flex flex-col gap-2">
          <p className="text-[13px] text-ink2">
            Copy the signing secret now; it will not be shown again. Verify each delivery’s <span className="font-mono text-xs">webhook-signature</span> with it
            (any Standard Webhooks library does this).
          </p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-[8px] bg-sunk px-2 py-1 font-mono text-xs">{secret.secret}</code>
            <button className="btn-ghost text-xs" onClick={() => void navigator.clipboard.writeText(secret.secret).then(() => toast("Secret copied"))}>
              Copy
            </button>
          </div>
          <div className="flex justify-end gap-2">
            <button className="btn-ghost min-w-[7.5rem]" disabled={test.isPending} onClick={() => test.mutate({ id: secret.id })}>
              {test.isPending ? "Sending…" : "Send test"}
            </button>
            <button className="btn-ink" onClick={() => onOpenChange(false)}>
              Done
            </button>
          </div>
        </div>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <label className="flex flex-col gap-1">
            <span className="text-xs font-semibold text-ink2">URL</span>
            <input
              className="input font-mono text-xs"
              placeholder="https://your-n8n/webhook/… or a Zapier catch hook"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              autoFocus
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-semibold text-ink2">Label (optional)</span>
            <input
              className="input"
              placeholder="e.g. n8n clips workflow"
              value={description}
              maxLength={120}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1 text-xs font-semibold text-ink2">Events</legend>
            {(types.data ?? Object.keys(EVENT_LABEL)).map((t) => (
              <label key={t} className="flex items-center gap-2 text-[13px]">
                <input
                  type="checkbox"
                  checked={events.includes(t)}
                  onChange={(e) => setEvents((s) => (e.target.checked ? [...s, t] : s.filter((x) => x !== t)))}
                />
                <span className="font-mono text-xs">{t}</span>
                <span className="text-ink3">{EVENT_LABEL[t]}</span>
              </label>
            ))}
          </fieldset>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-quiet" onClick={() => onOpenChange(false)}>
              Cancel
            </button>
            <button type="submit" className="btn-ink min-w-[7.5rem]" disabled={!valid || pending}>
              {pending ? "Saving…" : edit ? "Save" : "Add webhook"}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

/** One endpoint's delivery log: status, attempts, the request and the receiver's answer, with Resend. */
function DeliveryLog({ endpoint, onClose }: { endpoint: Endpoint; onClose: () => void }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [open, setOpen] = useState<number | null>(null);
  const list = useInfiniteQuery(
    trpc.webhooks.deliveries.infiniteQueryOptions(
      { endpointId: endpoint.id, limit: 50 },
      { getNextPageParam: (last) => last.nextCursor ?? undefined, placeholderData: keepPreviousData, refetchOnWindowFocus: true },
    ),
  );
  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items) ?? [], [list.data]);
  const total = list.data?.pages[0]?.total ?? 0;
  const more = useLoadMoreSentinel(() => void list.fetchNextPage(), !!list.hasNextPage && !list.isFetching);
  const resend = useMutation(
    trpc.webhooks.resend.mutationOptions({
      onSuccess: (r) => {
        toast(r.message);
        void qc.invalidateQueries({ queryKey: trpc.webhooks.pathKey() });
      },
      onError: (e) => toast.error(e.message),
    }),
  );
  return (
    <div className="flex flex-col gap-2 rounded-[12px] border border-line bg-sunk/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <b className="truncate text-[13px]">Deliveries to {endpoint.description ?? endpoint.urlMasked}</b>
        <button className="btn-quiet text-xs" onClick={onClose}>
          Close
        </button>
      </div>
      {list.isPending && (
        <SkeletonRegion label="Loading deliveries…" className="flex flex-col gap-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </SkeletonRegion>
      )}
      {list.error && <span className="text-[13px] text-err">✕ {list.error.message}</span>}
      {list.data && !items.length && <span className="text-[13px] text-ink3">Nothing sent yet. Send a test, or wait for the next event.</span>}
      {items.length > 0 && (
        <ul className="divide-y divide-line text-[13px]">
          {items.map((d) => (
            <li key={d.id} className="py-1.5">
              <button
                className="grid w-full grid-cols-[6.5rem_minmax(0,1fr)_3.5rem_8rem] items-center gap-x-3 text-left"
                onClick={() => setOpen(open === d.id ? null : d.id)}
                aria-expanded={open === d.id}
              >
                <span className={`text-xs ${DELIVERY[d.status].cls}`}>
                  {DELIVERY[d.status].glyph} <span className="text-ink2">{DELIVERY[d.status].word}</span>
                </span>
                <span className="truncate font-mono text-xs">{d.type}</span>
                <span className="text-right text-xs tabular-nums text-ink2">{d.lastStatusCode ?? "–"}</span>
                <span className="text-right text-xs text-ink3">{when(d.createdAt)}</span>
              </button>
              {open === d.id && (
                <div className="mt-2 flex flex-col gap-2 text-xs">
                  <span className="text-ink2">
                    {d.attempt} attempt{d.attempt === 1 ? "" : "s"}
                    {d.lastError ? ` · ${d.lastError}` : ""}
                    {d.nextAttemptAt && d.status === "pending" ? ` · next try ${when(d.nextAttemptAt)}` : ""}
                    {d.deliveredAt ? ` · delivered ${when(d.deliveredAt)}` : ""}
                    {` · ${d.eventId}`}
                  </span>
                  {d.body && (
                    <ScrollArea className="max-h-48 rounded-[8px] bg-panel">
                      <pre className="w-max p-2 font-mono text-[11px] leading-4">{JSON.stringify(JSON.parse(d.body), null, 2)}</pre>
                    </ScrollArea>
                  )}
                  {d.lastResponse && (
                    <ScrollArea className="max-h-24 rounded-[8px] bg-panel">
                      <pre className="w-max p-2 font-mono text-[11px] leading-4">{d.lastResponse}</pre>
                    </ScrollArea>
                  )}
                  <div>
                    <button
                      className="btn-ghost min-w-[5.5rem] text-xs"
                      disabled={resend.isPending || d.status === "pending" || d.status === "sending" || !endpoint.enabled}
                      title={
                        !endpoint.enabled
                          ? "Turn the webhook on first"
                          : d.status === "pending" || d.status === "sending"
                            ? "Still being sent"
                            : "Send it again"
                      }
                      onClick={() => resend.mutate({ deliveryId: d.id })}
                    >
                      Resend
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {items.length > 0 && (
        <span className="text-xs text-ink3">
          Showing {items.length} of {total}
        </span>
      )}
      <div ref={more} />
    </div>
  );
}

/** Settings → Webhooks: where Reelsaw POSTs signed events, their health, and each one's delivery log. */
export function WebhooksSection() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const list = useQuery(trpc.webhooks.list.queryOptions());
  const [dialog, setDialog] = useState<{ edit: Endpoint | null } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Endpoint | null>(null);
  const [selected, setSelected] = useState<string | null>(readHash);
  const [rotated, setRotated] = useState<{ secret: string; until: string } | null>(null);
  const invalidate = () => void qc.invalidateQueries({ queryKey: trpc.webhooks.pathKey() });
  const onError = (e: { message: string }) => toast.error(e.message);
  const update = useMutation(trpc.webhooks.update.mutationOptions({ onSuccess: (r) => (toast(r.message), invalidate()), onError }));
  const remove = useMutation(trpc.webhooks.delete.mutationOptions({ onSuccess: (r) => (toast(r.message), invalidate()), onError }));
  const test = useMutation(trpc.webhooks.test.mutationOptions({ onSuccess: (r) => ((r.ok ? toast : toast.error)(r.message), invalidate()), onError }));
  const rotate = useMutation(
    trpc.webhooks.rotateSecret.mutationOptions({
      onSuccess: (r) => {
        setRotated({ secret: r.secret, until: when(r.previousStopsAt) });
        invalidate();
      },
      onError,
    }),
  );

  useEffect(() => {
    if (window.location.hash.startsWith("#webhooks")) document.getElementById("webhooks")?.scrollIntoView({ block: "start" });
  }, []);
  useEffect(() => {
    if (selected || window.location.hash.startsWith("#webhooks")) writeHash(selected);
  }, [selected]);

  const endpoints = (list.data ?? []) as Endpoint[];
  const sel = endpoints.find((e) => e.id === selected) ?? null;

  return (
    <section id="webhooks" className="flex scroll-mt-4 flex-col gap-3 rounded-[16px] border border-line bg-panel p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[15px] font-bold">Webhooks</h2>
        <button className="btn-ink min-w-[8rem] text-xs" onClick={() => setDialog({ edit: null })}>
          Add webhook
        </button>
      </div>
      <p className="text-[13px] text-ink2">
        Reelsaw POSTs signed JSON to these URLs when clips are ready, so n8n, Zapier, Make or your own script can post them, without polling. Deliveries are
        retried for about a day; a URL that keeps failing is turned off and you get an email.
      </p>
      {rotated && (
        <div className="flex flex-col gap-2 rounded-[12px] border border-acc/40 bg-acc-soft p-3 text-[13px]">
          <div className="flex items-center justify-between gap-2">
            <b>New secret. Copy it now; the old one keeps signing until {rotated.until}.</b>
            <button className="btn-quiet text-xs" onClick={() => setRotated(null)}>
              Done
            </button>
          </div>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-[8px] bg-panel px-2 py-1 font-mono text-xs">{rotated.secret}</code>
            <button className="btn-ghost text-xs" onClick={() => void navigator.clipboard.writeText(rotated.secret).then(() => toast("Secret copied"))}>
              Copy
            </button>
          </div>
        </div>
      )}
      <div className="min-h-6 text-[13px]">
        {list.isPending && (
          <SkeletonRegion label="Loading webhooks…" className="divide-y divide-line">
            {["w-1/3", "w-1/4"].map((w, i) => (
              <div key={i} className="flex items-center gap-3 py-2">
                <Skeleton className={`h-4 ${w}`} />
                <Skeleton className="ml-auto h-3.5 w-28" />
                <Skeleton className="h-7 w-28 rounded-[8px]" />
              </div>
            ))}
          </SkeletonRegion>
        )}
        {list.error && <span className="text-err">✕ {list.error.message}</span>}
        {list.data && !endpoints.length && (
          <span className="text-ink3">No webhooks yet. Add one to tell n8n, Zapier or your own script when clips are ready.</span>
        )}
        {endpoints.length > 0 && (
          <ul className="divide-y divide-line">
            <li aria-hidden className="hidden grid-cols-[minmax(0,1fr)_7rem_9rem_9.5rem] items-center gap-x-3 pb-1 text-xs text-ink3 md:grid">
              <span>Endpoint</span>
              <span>Status</span>
              <span>Last delivery</span>
              <span />
            </li>
            {endpoints.map((e) => (
              <li
                key={e.id}
                className="grid min-h-[3.25rem] grid-cols-[minmax(0,1fr)_9.5rem] items-center gap-x-3 py-2 md:grid-cols-[minmax(0,1fr)_7rem_9rem_9.5rem]"
              >
                <button className="flex min-w-0 flex-col text-left" onClick={() => setSelected(selected === e.id ? null : e.id)} title="Show the delivery log">
                  <span className="truncate font-semibold">{e.description ?? e.urlMasked}</span>
                  <span className="truncate text-xs text-ink3">
                    {e.description ? `${e.urlMasked} · ` : ""}
                    {e.events.length > 2 ? `${e.events.length} events` : e.events.join(", ")}
                    <span className="md:hidden"> · {STATUS[e.status].word.toLowerCase()}</span>
                  </span>
                </button>
                <span
                  className={`hidden text-xs md:block ${STATUS[e.status].cls}`}
                  title={e.disabledReason ?? (e.failingSince ? `Failing since ${when(e.failingSince)}` : undefined)}
                >
                  {STATUS[e.status].glyph}{" "}
                  <span className="text-ink2">
                    {e.status === "failing" && e.failingSince ? `Failing since ${when(e.failingSince).split(",")[0]}` : STATUS[e.status].word}
                  </span>
                </span>
                <span className="hidden truncate text-xs text-ink3 md:block">
                  {e.lastDelivery ? `${DELIVERY[e.lastDelivery.status].word} ${e.lastDelivery.code ?? ""} · ${when(e.lastDelivery.at)}` : "none yet"}
                </span>
                <span className="flex justify-end gap-1.5">
                  <button
                    className="btn-ghost w-[4.5rem] text-xs"
                    disabled={!e.enabled || test.isPending}
                    title={e.enabled ? "Send a test delivery now" : "Turn it on first"}
                    onClick={() => test.mutate({ id: e.id })}
                  >
                    Test
                  </button>
                  <DropdownMenu.Root>
                    <DropdownMenu.Trigger asChild>
                      <MoreButton aria-label={`More actions for ${e.description ?? e.urlMasked}`} />
                    </DropdownMenu.Trigger>
                    <DropdownMenu.Portal>
                      <DropdownMenu.Content side="bottom" align="end" sideOffset={6} className="menu w-[200px]">
                        <DropdownMenu.Item className="menu-item" onSelect={() => setSelected(e.id)}>
                          Delivery log
                        </DropdownMenu.Item>
                        <DropdownMenu.Item className="menu-item" onSelect={() => window.setTimeout(() => setDialog({ edit: e }), 0)}>
                          Edit…
                        </DropdownMenu.Item>
                        <DropdownMenu.Item className="menu-item" onSelect={() => rotate.mutate({ id: e.id })}>
                          Rotate secret
                        </DropdownMenu.Item>
                        <DropdownMenu.Item className="menu-item" onSelect={() => update.mutate({ id: e.id, enabled: !e.enabled })}>
                          {e.enabled ? "Turn off" : "Turn on"}
                        </DropdownMenu.Item>
                        <DropdownMenu.Separator className="mx-1.5 my-1 h-px bg-line" />
                        <DropdownMenu.Item className="menu-item-danger" onSelect={() => window.setTimeout(() => setConfirmDelete(e), 0)}>
                          Delete…
                        </DropdownMenu.Item>
                      </DropdownMenu.Content>
                    </DropdownMenu.Portal>
                  </DropdownMenu.Root>
                </span>
                {e.status === "off" && e.disabledReason && (
                  <span className="col-span-full text-xs text-ink3">{e.disabledReason} Turn it on once the receiver is fixed.</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {sel && <DeliveryLog endpoint={sel} onClose={() => setSelected(null)} />}
      {dialog && <EndpointDialog open onOpenChange={(o) => !o && setDialog(null)} edit={dialog.edit} />}
      <ConfirmDialog
        open={!!confirmDelete}
        onOpenChange={(o) => !o && setConfirmDelete(null)}
        title="Delete this webhook?"
        body={<>Nothing more is sent to {confirmDelete?.urlMasked}, and its delivery log is removed.</>}
        confirm="Delete"
        danger
        onConfirm={() => {
          if (confirmDelete) remove.mutate({ id: confirmDelete.id });
          if (confirmDelete?.id === selected) setSelected(null);
          setConfirmDelete(null);
        }}
      />
    </section>
  );
}
