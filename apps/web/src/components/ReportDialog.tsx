import { useEffect, useRef, useState, type ReactNode } from "react";
import { z } from "zod";
import { useShortcut } from "../lib/shortcuts";
import { useMutation, useQuery } from "@tanstack/react-query";
import * as Dialog from "@radix-ui/react-dialog";
import { Loader2 } from "lucide-react";
import type { ReportInclude } from "@reelsaw/shared";
import { Modal, Skeleton } from "./ui";
import { ScrollArea } from "./scroll-area";
import { MultiCombobox } from "./MultiCombobox";
import { useTRPC } from "../lib/trpc";
import { useMe } from "../lib/account";
import { toast } from "sonner";
import { clientContext } from "../lib/diagnostics";
import { closeReport, openReportHere, REPORT_SHORTCUT, useReportTarget } from "../lib/report";
import { sendIssueFeedback } from "../lib/telemetry";
import { formatNumber } from "@reelsaw/shared";
import { plural } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";

const previewSchema = z.object({
  sourceType: z.enum(["url", "upload"]),
  sourceUrl: z.string().nullable(),
  sourceBytes: z.number(),
  clipsBytes: z.number(),
  clips: z.number(),
  logs: z.boolean(),
});
type Preview = z.infer<typeof previewSchema>;

const oneDecimal = (n: number) => formatNumber(n, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const mb = (n: number) => (n >= 1e9 ? `${oneDecimal(n / 1e9)} GB` : `${oneDecimal(Math.max(0.1, n / 1e6))} MB`);

/**
 * "Report an issue": on self-host (and admins everywhere) a zip for local reproduction; on hosted
 * with Sentry/PostHog, feedback goes through those channels instead (me.report from the server).
 */
export function ReportDialog() {
  const { t } = useLingui();
  const target = useReportTarget();
  const open = !!target;
  const projectId = target?.projectId;
  const trpc = useTRPC();
  const me = useMe();
  const caps = me.data?.report ?? { zip: true, system: true, instance: false, feedback: false };
  const feedbackOnly = !caps.zip && caps.feedback;
  const project = useQuery({ ...trpc.projects.get.queryOptions({ id: projectId ?? "" }), enabled: !!projectId && open });
  const clips = (project.data?.clips ?? []).slice().sort((a, b) => a.index - b.index);
  const previewQ = useQuery({
    queryKey: ["report-preview", projectId],
    queryFn: async (): Promise<Preview | null> => {
      const r = await fetch(`/api/projects/${projectId}/report/preview`, { credentials: "include" });
      if (!r.ok) return null;
      return previewSchema.parse(await r.json());
    },
    enabled: open && !!projectId && !feedbackOnly,
  });
  const preview = previewQ.data ?? null;
  const [text, setText] = useState("");
  const [clipIds, setClipIds] = useState<string[]>([]);
  const [inc, setInc] = useState<ReportInclude>({ logs: true, system: caps.system, instance: false, previews: true, allClips: false, source: false });
  const [hint, setHint] = useState<string | null>(null);

  const submitM = useMutation({
    mutationFn: async () => {
      if (feedbackOnly) {
        const client = clientContext();
        const tags: Record<string, string> = { source: target?.tags?.["source"] ?? "report-dialog", ...target?.tags };
        if (projectId) tags["projectId"] = projectId;
        if (clipIds.length) tags["clipIds"] = clipIds.join(",");
        if (client.route) tags["route"] = client.route;
        const sent = await sendIssueFeedback({
          message: text.trim(),
          name: me.data?.name,
          email: me.data?.email,
          tags,
          properties: {
            project_id: projectId ?? null,
            clip_count: clipIds.length,
            route: client.route ?? null,
            via: "feedback",
          },
        });
        if (!sent.sentry && !sent.posthog) throw new Error(t`Feedback channels are not available right now.`);
        return { kind: "feedback" as const };
      }
      const include = { ...inc, system: caps.system && inc.system, instance: !!caps.instance && inc.instance };
      const res = await fetch(projectId ? `/api/projects/${projectId}/report` : "/api/report", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ description: text, clipIds, include, client: clientContext() }),
      });
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => null);
        const status = res.status;
        const why =
          body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : t`Couldn’t build the report (${status})`;
        throw new Error(why);
      }
      const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "reelsaw-report.zip";
      const url = URL.createObjectURL(await res.blob());
      const a = Object.assign(document.createElement("a"), { href: url, download: name });
      document.body.appendChild(a);
      a.click();
      a.remove();
      urls.current.add(url);
      setTimeout(() => {
        URL.revokeObjectURL(url);
        urls.current.delete(url);
      }, 10_000);
      if (caps.feedback) {
        const client = clientContext();
        void sendIssueFeedback({
          message: text.trim(),
          name: me.data?.name,
          email: me.data?.email,
          tags: {
            source: target?.tags?.["source"] ?? "report-dialog",
            ...target?.tags,
            ...(projectId ? { projectId } : {}),
            ...(client.route ? { route: client.route } : {}),
          },
          properties: { project_id: projectId ?? null, clip_count: clipIds.length, route: client.route ?? null, via: "zip" },
        }).catch(() => {});
      }
      return { kind: "zip" as const, name };
    },
    onSuccess: (r) => {
      closeReport();
      if (r.kind === "feedback") toast(t`Thanks — we got your report`);
      else {
        const name = r.name;
        toast(t`Saved “${name}” to your downloads · send it to the Reelsaw team`);
      }
    },
  });

  // "!" opens the report from anywhere (ignored while typing)
  useShortcut(REPORT_SHORTCUT, () => openReportHere(), { useKey: true });

  // object URLs of downloaded reports still waiting for their delayed revoke; unmounting releases them
  const urls = useRef(new Set<string>());
  useEffect(() => {
    const held = urls.current;
    return () => {
      for (const u of held) URL.revokeObjectURL(u);
      held.clear();
    };
  }, []);

  // reset per opening
  useEffect(() => {
    if (!open) return;
    setText(target?.prefill ?? "");
    setHint(null);
    setClipIds(target?.clipId ? [target.clipId] : []);
    setInc({ logs: true, system: caps.system, instance: false, previews: true, allClips: false, source: false });
    submitM.reset();
    // reset is stable; opening is the trigger
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectId, target?.clipId, target?.prefill, caps.system]);

  const submit = () => {
    if (text.trim().length < 3) {
      submitM.reset();
      setHint(t`Describe what went wrong (a sentence is enough).`);
      return;
    }
    setHint(null);
    submitM.mutate();
  };

  const error = submitM.error?.message ?? hint;
  const busy = submitM.isPending;

  const row = (key: keyof ReportInclude, label: string, hint: ReactNode, disabled = false) => (
    <label className={`flex items-start gap-2.5 ${disabled ? "opacity-50" : "cursor-pointer"}`}>
      <input
        type="checkbox"
        className="mt-0.5 h-4 w-4 accent-[var(--acc)]"
        checked={key === "system" ? inc.system || inc.instance : inc[key]}
        disabled={disabled}
        onChange={(e) =>
          setInc((x) => {
            const on = e.target.checked;
            if (key === "instance") return { ...x, instance: on, system: on || x.system };
            return { ...x, [key]: on };
          })
        }
      />
      <span className="min-w-0">
        <span className="block text-sm">{label}</span>
        <span className="block min-h-4 text-xs text-ink3">{hint}</span>
      </span>
    </label>
  );

  const sourceSize = preview ? mb(preview.sourceBytes) : "";
  const projectTitle = project.data?.title ?? target?.projectTitle ?? t`this project`;
  const uploadWithoutSource = !feedbackOnly && preview?.sourceType === "upload" && !inc.source;
  return (
    <Modal open={open} onOpenChange={(o) => !o && !busy && closeReport()} title={t`Report an issue`} width={520}>
      <ScrollArea className="max-h-[min(60dvh,calc(90dvh-8rem))]">
        <div className="flex flex-col gap-3 pe-3">
          <Dialog.Description className="-mt-1 text-sm text-ink2">
            {projectId ? (
              <>
                <Trans>
                  About <b className="text-ink">{projectTitle}</b>.
                </Trans>{" "}
              </>
            ) : null}
            {feedbackOnly
              ? t`Sends your description to the Reelsaw team. API keys and passwords are never included.`
              : t`Saves a zip you can send to the Reelsaw team. API keys and passwords are never included.`}
          </Dialog.Description>

          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-semibold">
              <Trans>What went wrong?</Trans>
            </span>
            <textarea
              className="input min-h-[96px] resize-y"
              autoFocus
              maxLength={10000}
              placeholder={t`What you did, what you expected, and what happened instead. Timestamps help (e.g. “clip 3 at 0:42”).`}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
              }}
            />
          </label>

          {projectId && project.isPending && (
            <div className="flex flex-col gap-1.5" role="status">
              <span className="sr-only">
                <Trans>Loading clips…</Trans>
              </span>
              <span className="text-sm font-semibold">
                <Trans>Clips</Trans>
              </span>
              <Skeleton className="h-[38px] w-full rounded-[10px]" />
            </div>
          )}
          {projectId && clips.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-semibold">
                <Trans>Clips</Trans>
              </span>
              <MultiCombobox
                label={t`Clips the problem shows up in`}
                placeholder={t`None in particular`}
                searchPlaceholder={t`Search clips by number or title…`}
                empty={t`No clips match`}
                footerHint={t`Pick any that show the problem`}
                value={clipIds}
                onChange={setClipIds}
                options={clips.map((c) => ({
                  value: c.id,
                  prefix: String(c.index + 1),
                  label: c.title,
                  hint:
                    c.status === "failed" ? (
                      <span className="text-err">
                        <Trans>failed</Trans>
                      </span>
                    ) : undefined,
                }))}
              />
            </div>
          )}

          {!feedbackOnly && (
            <fieldset className="flex flex-col gap-2 rounded-[12px] border border-line p-3">
              <legend className="px-1 text-xs font-semibold text-ink2">
                <Trans>Included</Trans>
              </legend>
              <span className="text-xs text-ink2">
                {projectId
                  ? t`Project settings, transcript, fixes, clips, pipeline decisions and the event history, the app’s settings (secrets shown only as set/unset), and your description.`
                  : inc.instance
                    ? t`This instance’s unfinished work, job queue, usage and recent failures, the app’s settings (secrets shown only as set/unset), and your description.`
                    : t`Your projects' status and recent failures, the app’s settings (secrets shown only as set/unset), and your description.`}
              </span>
              {caps.instance &&
                row(
                  "instance",
                  t`Instance-wide diagnostics`,
                  t`Unfinished work, failed jobs, usage and error logs across every account — for queue, disk or machine problems, not only your projects. Other accounts’ project titles and ids are included.`,
                )}
              {caps.system &&
                row(
                  "system",
                  t`System info and recent errors`,
                  inc.instance
                    ? t`Included with instance-wide diagnostics`
                    : t`Versions, CPU/memory/disk, job counts, your usage, and error lines that aren’t tied to another account`,
                  inc.instance,
                )}
              {projectId &&
                row(
                  "logs",
                  t`Logs for this project`,
                  preview && !preview.logs ? t`This instance doesn’t keep a log file` : t`Pipeline log lines, including model calls when they’re recorded`,
                  !!preview && !preview.logs,
                )}
              {projectId &&
                row(
                  "previews",
                  t`Thumbnails and the selected clips' videos`,
                  clipIds.length ? t`So we can see what you saw` : t`Thumbnails only until you pick clips`,
                )}
              {projectId &&
                row(
                  "allClips",
                  t`All rendered clips`,
                  preview ? (
                    `${plural(preview.clips, { one: "# clip", other: "# clips" })} · ${mb(preview.clipsBytes)}`
                  ) : (
                    <Skeleton className="mt-0.5 inline-block h-3 w-28" />
                  ),
                )}
              {projectId &&
                row(
                  "source",
                  t`Source video`,
                  preview ? (
                    preview.sourceType === "url" ? (
                      t`${sourceSize} · not needed when the link still works`
                    ) : (
                      t`${sourceSize} · needed to reproduce problems with uploads`
                    )
                  ) : (
                    <Skeleton className="mt-0.5 inline-block h-3 w-40" />
                  ),
                )}
            </fieldset>
          )}
        </div>
      </ScrollArea>

      {/* one reserved line for notes and errors, so the buttons never move */}
      <p className={`min-h-[18px] shrink-0 text-xs ${error ? "text-err" : "text-ink3"}`} role={error ? "alert" : undefined}>
        {error ?? (uploadWithoutSource ? t`Without the source video, problems that depend on the video itself can’t be reproduced.` : "")}
      </p>

      <div className="flex shrink-0 items-center justify-end gap-2">
        <button className="btn-ghost" disabled={busy} onClick={closeReport}>
          <Trans>Cancel</Trans>
        </button>
        <button className="btn-ink min-w-[10.5rem]" disabled={busy} onClick={submit}>
          {busy ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" /> {feedbackOnly ? t`Sending…` : t`Preparing…`}
            </>
          ) : feedbackOnly ? (
            t`Send feedback`
          ) : (
            t`Download report`
          )}
        </button>
      </div>
    </Modal>
  );
}
