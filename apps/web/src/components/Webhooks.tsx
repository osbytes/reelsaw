import { useEffect, useMemo, useState } from "react";
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { toast } from "sonner";
import { copyText } from "../lib/clipboard";
import { useTRPC } from "../lib/trpc";
import { useLoadMoreSentinel } from "../lib/useLoadMore";
import { ConfirmDialog, Modal, MoreButton, Skeleton, SkeletonRegion } from "./ui";
import { ScrollArea, SECTION_LIST_MAX_H } from "./scroll-area";
import { formatDateTime, formatDay, formatNumber } from "@reelsaw/shared";

const EVENT_LABEL: Record<string, MessageDescriptor> = {
  "project.created": msg`Project created`,
  "project.done": msg`Project finished (every clip, share links, zip)`,
  "project.failed": msg`Project failed`,
  "clip.done": msg`Clip rendered (re-renders too)`,
  "clip.failed": msg`Clip failed`,
};
const STATUS = {
  active: { glyph: "●", word: msg`Active`, cls: "text-ok" },
  failing: { glyph: "▲", word: msg`Failing`, cls: "text-warn" },
  off: { glyph: "○", word: msg`Off`, cls: "text-ink3" },
} as const;
const DELIVERY = {
  pending: { glyph: "◷", word: msg`Waiting`, cls: "text-ink3" },
  sending: { glyph: "◷", word: msg`Sending`, cls: "text-acc-text" },
  delivered: { glyph: "✓", word: msg`Delivered`, cls: "text-ok" },
  failed: { glyph: "✕", word: msg`Failed`, cls: "text-err" },
  cancelled: { glyph: "○", word: msg`Cancelled`, cls: "text-ink3" },
} as const;

function when(d: Date | string | null | undefined) {
  if (!d) return "";
  return formatDateTime(d);
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
  const { t } = useLingui();
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
    <Modal open={open} onOpenChange={onOpenChange} title={edit ? t`Edit webhook` : t`Add webhook`} width={520}>
      {secret ? (
        <div className="flex flex-col gap-2">
          <p className="text-[13px] text-ink2">
            <Trans>
              Copy the signing secret now; it will not be shown again. Verify each delivery’s <span className="font-mono text-xs">webhook-signature</span> with
              it (any Standard Webhooks library does this).
            </Trans>
          </p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-[8px] bg-sunk px-2 py-1 font-mono text-xs">{secret.secret}</code>
            <button className="btn-ghost text-xs" onClick={() => copyText(secret.secret, t`Secret copied`)}>
              <Trans>Copy</Trans>
            </button>
          </div>
          <div className="flex justify-end gap-2">
            <button className="btn-ghost min-w-[7.5rem]" disabled={test.isPending} onClick={() => test.mutate({ id: secret.id })}>
              {test.isPending ? <Trans>Sending…</Trans> : <Trans>Send test</Trans>}
            </button>
            <button className="btn-ink" onClick={() => onOpenChange(false)}>
              <Trans>Done</Trans>
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
            <span className="text-xs font-semibold text-ink2">
              <Trans>URL</Trans>
            </span>
            <input
              className="input font-mono text-xs"
              placeholder={t`https://your-n8n/webhook/… or a Zapier catch hook`}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              autoFocus
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-xs font-semibold text-ink2">
              <Trans>Label (optional)</Trans>
            </span>
            <input
              className="input"
              placeholder={t`e.g. n8n clips workflow`}
              value={description}
              maxLength={120}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1 text-xs font-semibold text-ink2">
              <Trans>Events</Trans>
            </legend>
            {(types.data ?? Object.keys(EVENT_LABEL)).map((type) => {
              const label = EVENT_LABEL[type];
              return (
                <label key={type} className="flex items-center gap-2 text-[13px]">
                  <input
                    type="checkbox"
                    checked={events.includes(type)}
                    onChange={(e) => setEvents((s) => (e.target.checked ? [...s, type] : s.filter((x) => x !== type)))}
                  />
                  <span className="font-mono text-xs">{type}</span>
                  <span className="text-ink3">{label ? t(label) : null}</span>
                </label>
              );
            })}
          </fieldset>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-quiet" onClick={() => onOpenChange(false)}>
              <Trans>Cancel</Trans>
            </button>
            <button type="submit" className="btn-ink min-w-[7.5rem]" disabled={!valid || pending}>
              {pending ? <Trans>Saving…</Trans> : edit ? <Trans>Save</Trans> : <Trans>Add webhook</Trans>}
            </button>
          </div>
        </form>
      )}
    </Modal>
  );
}

/** One endpoint's delivery log: status, attempts, the request and the receiver's answer, with Resend. */
function DeliveryLog({ endpoint, onClose }: { endpoint: Endpoint; onClose: () => void }) {
  const { t } = useLingui();
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
  const target = endpoint.description ?? endpoint.urlMasked;
  const shown = formatNumber(items.length);
  return (
    <div className="flex flex-col gap-2 rounded-[12px] border border-line bg-sunk/40 p-3">
      <div className="flex items-center justify-between gap-2">
        <b className="truncate text-[13px]">
          <Trans>Deliveries to {target}</Trans>
        </b>
        <button className="btn-quiet text-xs" onClick={onClose}>
          <Trans>Close</Trans>
        </button>
      </div>
      {list.isPending && (
        <SkeletonRegion label={t`Loading deliveries…`} className="flex flex-col gap-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </SkeletonRegion>
      )}
      {list.error && <span className="text-[13px] text-err">✕ {list.error.message}</span>}
      {list.data && !items.length && (
        <span className="text-[13px] text-ink3">
          <Trans>Nothing sent yet. Send a test, or wait for the next event.</Trans>
        </span>
      )}
      {items.length > 0 && (
        <ScrollArea className={SECTION_LIST_MAX_H}>
          <ul className="divide-y divide-line text-[13px]">
            {items.map((d) => {
              const next = when(d.nextAttemptAt);
              const delivered = when(d.deliveredAt);
              return (
                <li key={d.id} className="py-1.5">
                  <button
                    className="grid w-full grid-cols-[6rem_minmax(0,1fr)_2.5rem] items-center gap-x-3 text-start md:grid-cols-[6.5rem_minmax(0,1fr)_3.5rem_8rem]"
                    onClick={() => setOpen(open === d.id ? null : d.id)}
                    aria-expanded={open === d.id}
                  >
                    <span className={`text-xs ${DELIVERY[d.status].cls}`}>
                      {DELIVERY[d.status].glyph} <span className="text-ink2">{t(DELIVERY[d.status].word)}</span>
                    </span>
                    <span className="truncate font-mono text-xs">{d.type}</span>
                    <span className="text-end text-xs tabular-nums text-ink2">{d.lastStatusCode ?? "–"}</span>
                    <span className="col-span-2 col-start-2 text-xs text-ink3 md:col-span-1 md:col-start-auto md:text-end">{when(d.createdAt)}</span>
                  </button>
                  {open === d.id && (
                    <div className="mt-2 flex flex-col gap-2 text-xs">
                      <span className="text-ink2">
                        <Plural value={d.attempt} one="# attempt" other="# attempts" />
                        {d.lastError ? ` · ${d.lastError}` : ""}
                        {d.nextAttemptAt && d.status === "pending" ? (
                          <>
                            {" · "}
                            <Trans>next try {next}</Trans>
                          </>
                        ) : null}
                        {d.deliveredAt ? (
                          <>
                            {" · "}
                            <Trans>delivered {delivered}</Trans>
                          </>
                        ) : null}
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
                              ? t`Turn the webhook on first`
                              : d.status === "pending" || d.status === "sending"
                                ? t`Still being sent`
                                : t`Send it again`
                          }
                          onClick={() => resend.mutate({ deliveryId: d.id })}
                        >
                          <Trans>Resend</Trans>
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {/* inside the scroll area, so the next page loads as the log (not the page) scrolls to its end */}
          <div ref={more} />
        </ScrollArea>
      )}
      {items.length > 0 && (
        <span className="text-xs text-ink3">
          {items.length < total ? (
            <Plural value={total} one={`Showing ${shown} of # delivery`} other={`Showing ${shown} of # deliveries`} />
          ) : (
            <Plural value={total} one="# delivery" other="# deliveries" />
          )}
        </span>
      )}
    </div>
  );
}

/** Settings → Webhooks: where Reelsaw POSTs signed events, their health, and each one's delivery log. */
export function WebhooksSection() {
  const { t } = useLingui();
  const trpc = useTRPC();
  const qc = useQueryClient();
  const list = useQuery(trpc.webhooks.list.queryOptions());
  const [dialog, setDialog] = useState<{ edit: Endpoint | null } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<Endpoint | null>(null);
  const [confirmRotate, setConfirmRotate] = useState<Endpoint | null>(null);
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

  const statusWord = (e: Pick<Endpoint, "status" | "failingSince">) => {
    if (e.status === "failing" && e.failingSince) {
      const since = formatDay(e.failingSince, { month: "short", year: false });
      return t`Failing since ${since}`;
    }
    return t(STATUS[e.status].word);
  };
  const rotateTarget = confirmRotate?.urlMasked ?? "";
  const deleteTarget = confirmDelete?.urlMasked ?? "";

  return (
    <section id="webhooks" className="flex scroll-mt-4 flex-col gap-3 rounded-[16px] border border-line bg-panel p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-[15px] font-bold">
          <Trans>Webhooks</Trans>
        </h2>
        <button className="btn-ink min-w-[8rem] text-xs" onClick={() => setDialog({ edit: null })}>
          <Trans>Add webhook</Trans>
        </button>
      </div>
      <p className="text-[13px] text-ink2">
        <Trans>
          Reelsaw POSTs signed JSON to these URLs when clips are ready, so n8n, Zapier, Make or your own script can post them, without polling. Deliveries are
          retried for about a day; a URL that keeps failing is turned off and you get an email.
        </Trans>
      </p>
      {rotated && (
        <div className="flex flex-col gap-2 rounded-[12px] border border-acc/40 bg-acc-soft p-3 text-[13px]">
          <div className="flex items-center justify-between gap-2">
            <b>
              <Trans>New secret. Copy it now; the old one keeps signing until {rotated.until}.</Trans>
            </b>
            <button className="btn-quiet text-xs" onClick={() => setRotated(null)}>
              <Trans>Done</Trans>
            </button>
          </div>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-[8px] bg-panel px-2 py-1 font-mono text-xs">{rotated.secret}</code>
            <button className="btn-ghost text-xs" onClick={() => copyText(rotated.secret, t`Secret copied`)}>
              <Trans>Copy</Trans>
            </button>
          </div>
        </div>
      )}
      <div className="min-h-6 text-[13px]">
        {list.isPending && (
          <SkeletonRegion label={t`Loading webhooks…`} className="divide-y divide-line">
            {["w-1/3", "w-1/4"].map((w, i) => (
              <div key={i} className="flex items-center gap-3 py-2">
                <Skeleton className={`h-4 ${w}`} />
                <Skeleton className="ms-auto h-3.5 w-28" />
                <Skeleton className="h-7 w-28 rounded-[8px]" />
              </div>
            ))}
          </SkeletonRegion>
        )}
        {list.error && <span className="text-err">✕ {list.error.message}</span>}
        {list.data && !endpoints.length && (
          <span className="text-ink3">
            <Trans>No webhooks yet. Add one to tell n8n, Zapier or your own script when clips are ready.</Trans>
          </span>
        )}
        {endpoints.length > 0 && (
          <ul className="divide-y divide-line">
            <li aria-hidden className="hidden grid-cols-[minmax(0,1fr)_7rem_9rem_9.5rem] items-center gap-x-3 pb-1 text-xs text-ink3 md:grid">
              <span>
                <Trans>Endpoint</Trans>
              </span>
              <span>
                <Trans>Status</Trans>
              </span>
              <span>
                <Trans>Last delivery</Trans>
              </span>
              <span />
            </li>
            {endpoints.map((e) => {
              const name = e.description ?? e.urlMasked;
              const lastWord = e.lastDelivery ? t(DELIVERY[e.lastDelivery.status].word) : "";
              const lastCode = e.lastDelivery?.code ?? "";
              const lastAt = e.lastDelivery ? when(e.lastDelivery.at) : "";
              const failingSince = when(e.failingSince);
              const rotationEnds = when(e.rotationEndsAt);
              const eventCount = e.events.length;
              return (
                <li
                  key={e.id}
                  className="grid min-h-[3.25rem] grid-cols-[minmax(0,1fr)_9.5rem] items-center gap-x-3 py-2 md:grid-cols-[minmax(0,1fr)_7rem_9rem_9.5rem]"
                >
                  <button
                    className="flex min-w-0 flex-col text-start"
                    onClick={() => setSelected(selected === e.id ? null : e.id)}
                    title={t`Show the delivery log`}
                  >
                    <span className="truncate font-semibold">{name}</span>
                    <span className="truncate text-xs text-ink3">
                      {e.description ? `${e.urlMasked} · ` : ""}
                      {eventCount > 2 ? <Plural value={eventCount} one="# event" other="# events" /> : e.events.join(", ")}
                    </span>
                    <span className="text-xs text-ink3 md:hidden">
                      <span className={STATUS[e.status].cls}>{STATUS[e.status].glyph}</span> <span className="text-ink2">{statusWord(e)}</span>
                      {e.lastDelivery ? (
                        <>
                          {" · "}
                          <Trans>
                            last: {lastWord} {lastCode}
                          </Trans>
                        </>
                      ) : null}
                    </span>
                  </button>
                  <span
                    className={`hidden text-xs md:block ${STATUS[e.status].cls}`}
                    title={e.disabledReason ?? (e.failingSince ? t`Failing since ${failingSince}` : undefined)}
                  >
                    {STATUS[e.status].glyph} <span className="text-ink2">{statusWord(e)}</span>
                  </span>
                  <span className="hidden truncate text-xs text-ink3 md:block">{e.lastDelivery ? `${lastWord} ${lastCode} · ${lastAt}` : t`none yet`}</span>
                  <span className="flex justify-end gap-1.5">
                    <button
                      className="btn-ghost w-[4.5rem] text-xs"
                      disabled={!e.enabled || test.isPending}
                      title={e.enabled ? t`Send a test delivery now` : t`Turn it on first`}
                      onClick={() => test.mutate({ id: e.id })}
                    >
                      <Trans>Test</Trans>
                    </button>
                    <DropdownMenu.Root>
                      <DropdownMenu.Trigger asChild>
                        <MoreButton aria-label={t`More actions for ${name}`} />
                      </DropdownMenu.Trigger>
                      <DropdownMenu.Portal>
                        <DropdownMenu.Content side="bottom" align="end" sideOffset={6} className="menu w-[200px]">
                          <DropdownMenu.Item className="menu-item" onSelect={() => setSelected(e.id)}>
                            <Trans>Delivery log</Trans>
                          </DropdownMenu.Item>
                          <DropdownMenu.Item className="menu-item" onSelect={() => window.setTimeout(() => setDialog({ edit: e }), 0)}>
                            <Trans>Edit…</Trans>
                          </DropdownMenu.Item>
                          {/* one rotation at a time: the server refuses a second one while the previous secret still signs */}
                          <DropdownMenu.Item
                            className="menu-item flex-col items-start gap-0"
                            disabled={!!e.rotationEndsAt}
                            onSelect={() => window.setTimeout(() => setConfirmRotate(e), 0)}
                          >
                            <Trans>Rotate secret…</Trans>
                            {e.rotationEndsAt && (
                              <span className="text-xs text-ink3">
                                <Trans>Old secret signs until {rotationEnds}</Trans>
                              </span>
                            )}
                          </DropdownMenu.Item>
                          <DropdownMenu.Item className="menu-item" onSelect={() => update.mutate({ id: e.id, enabled: !e.enabled })}>
                            {e.enabled ? <Trans>Turn off</Trans> : <Trans>Turn on</Trans>}
                          </DropdownMenu.Item>
                          <DropdownMenu.Separator className="mx-1.5 my-1 h-px bg-line" />
                          <DropdownMenu.Item className="menu-item-danger" onSelect={() => window.setTimeout(() => setConfirmDelete(e), 0)}>
                            <Trans>Delete…</Trans>
                          </DropdownMenu.Item>
                        </DropdownMenu.Content>
                      </DropdownMenu.Portal>
                    </DropdownMenu.Root>
                  </span>
                  {e.status === "off" && e.disabledReason && (
                    <span className="col-span-full text-xs text-ink3">
                      {e.disabledReason} <Trans>Turn it on once the receiver is fixed.</Trans>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {sel && <DeliveryLog endpoint={sel} onClose={() => setSelected(null)} />}
      {dialog && <EndpointDialog open onOpenChange={(o) => !o && setDialog(null)} edit={dialog.edit} />}
      <ConfirmDialog
        open={!!confirmRotate}
        onOpenChange={(o) => !o && setConfirmRotate(null)}
        title={t`Rotate this webhook’s secret?`}
        body={
          <Trans>
            Deliveries to {rotateTarget} are signed with both the new and the old secret for 24 hours. Update the receiver before then, or it starts refusing
            them. This cannot be reversed.
          </Trans>
        }
        confirm={t`Rotate secret`}
        onConfirm={() => (confirmRotate ? rotate.mutateAsync({ id: confirmRotate.id }) : Promise.resolve())}
      />
      <ConfirmDialog
        open={!!confirmDelete}
        onOpenChange={(o) => !o && setConfirmDelete(null)}
        title={t`Delete this webhook?`}
        body={<Trans>Nothing more is sent to {deleteTarget}, and its delivery log is removed.</Trans>}
        confirm={t`Delete`}
        danger
        onConfirm={() => {
          if (!confirmDelete) return Promise.resolve();
          const id = confirmDelete.id;
          return remove.mutateAsync({ id }).then(() => {
            if (id === selected) setSelected(null);
          });
        }}
      />
    </section>
  );
}
