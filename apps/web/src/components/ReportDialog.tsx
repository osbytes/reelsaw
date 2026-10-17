import { useEffect, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import * as Dialog from "@radix-ui/react-dialog";
import { Loader2 } from "lucide-react";
import type { ReportInclude } from "@reelsaw/shared";
import { Modal, Skeleton } from "./ui";
import { MultiCombobox } from "./MultiCombobox";
import { useTRPC } from "../lib/trpc";
import { toast } from "sonner";
import { clientContext } from "../lib/diagnostics";
import { closeReport, isReportShortcut, openReportHere, useReportTarget } from "../lib/report";

interface Preview {
  sourceType: "url" | "upload";
  sourceUrl: string | null;
  sourceBytes: number;
  clipsBytes: number;
  clips: number;
  logs: boolean;
}

const mb = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(0.1, n / 1e6).toFixed(1)} MB`);

/**
 * "Report an issue": the user's words plus the project's data, logs and (opted-in) media in one zip
 * they download and send. Secrets never go in; the contents are listed before saving.
 */
export function ReportDialog() {
  const target = useReportTarget();
  const open = !!target;
  const projectId = target?.projectId;
  const trpc = useTRPC();
  const project = useQuery({ ...trpc.projects.get.queryOptions({ id: projectId ?? "" }), enabled: !!projectId });
  const clips = (project.data?.clips ?? []).slice().sort((a, b) => a.index - b.index);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [text, setText] = useState("");
  const [clipIds, setClipIds] = useState<string[]>([]);
  const [inc, setInc] = useState<ReportInclude>({ logs: true, system: true, previews: true, allClips: false, source: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // "!" opens the report from anywhere (ignored while typing)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isReportShortcut(e)) return;
      e.preventDefault();
      openReportHere();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // reset per opening; fetch media sizes for the checkboxes
  useEffect(() => {
    if (!open) return;
    setText("");
    setError(null);
    setClipIds(target?.clipId ? [target.clipId] : []);
    setInc({ logs: true, system: true, previews: true, allClips: false, source: false });
    setPreview(null);
    if (!projectId) return;
    let live = true;
    fetch(`/api/projects/${projectId}/report/preview`, { credentials: "include" })
      .then((r) => (r.ok ? (r.json() as Promise<Preview>) : null))
      .then((p) => live && setPreview(p))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [open, projectId, target?.clipId]);

  async function download() {
    if (text.trim().length < 3) return setError("Describe what went wrong (a sentence is enough).");
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(projectId ? `/api/projects/${projectId}/report` : "/api/report", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ description: text, clipIds, include: inc, client: clientContext() }),
      });
      if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `Couldn't build the report (${res.status})`);
      const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "reelsaw-report.zip";
      const url = URL.createObjectURL(await res.blob());
      const a = Object.assign(document.createElement("a"), { href: url, download: name });
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      closeReport();
      toast(`Saved ${name} to your downloads · send it to the Reelsaw team`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const row = (key: keyof ReportInclude, label: string, hint: ReactNode, disabled = false) => (
    <label className={`flex items-start gap-2.5 ${disabled ? "opacity-50" : "cursor-pointer"}`}>
      <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--acc)]" checked={inc[key]} disabled={disabled} onChange={(e) => setInc((x) => ({ ...x, [key]: e.target.checked }))} />
      <span className="min-w-0">
        <span className="block text-sm">{label}</span>
        <span className="block min-h-4 text-xs text-ink3">{hint}</span>
      </span>
    </label>
  );

  const uploadWithoutSource = preview?.sourceType === "upload" && !inc.source;
  return (
    <Modal open={open} onOpenChange={(o) => !o && !busy && closeReport()} title="Report an issue" width={520}>
      <Dialog.Description className="-mt-1 text-sm text-ink2">
        {projectId ? <>About <b className="text-ink">{project.data?.title ?? target?.projectTitle ?? "this project"}</b>. </> : null}
        Saves a zip you can send to the Reelsaw team. API keys and passwords are never included.
      </Dialog.Description>

      <label className="flex flex-col gap-1.5">
        <span className="text-sm font-semibold">What went wrong?</span>
        <textarea
          className="input min-h-[96px] resize-y"
          autoFocus
          maxLength={10000}
          placeholder="What you did, what you expected, and what happened instead. Timestamps help (e.g. “clip 3 at 0:42”)."
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void download();
          }}
        />
      </label>

      {projectId && project.isPending && (
        <div className="flex flex-col gap-1.5" role="status">
          <span className="sr-only">Loading clips…</span>
          <span className="text-sm font-semibold">Clips</span>
          <Skeleton className="h-[38px] w-full rounded-[10px]" />
        </div>
      )}
      {projectId && clips.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-semibold">Clips</span>
          <MultiCombobox
            label="Clips the problem shows up in"
            placeholder="None in particular"
            searchPlaceholder="Search clips by number or title…"
            empty="No clip matches"
            value={clipIds}
            onChange={setClipIds}
            options={clips.map((c) => ({ value: c.id, prefix: String(c.index + 1), label: c.title, hint: c.status === "failed" ? <span className="text-err">failed</span> : undefined }))}
          />
        </div>
      )}

      <fieldset className="flex flex-col gap-2 rounded-[12px] border border-line p-3">
        <legend className="px-1 text-xs font-semibold text-ink2">Included</legend>
        <span className="text-xs text-ink2">
          {projectId ? "Project settings, transcript, fixes, clips, pipeline decisions and the event history" : "Your projects' status and recent failures"}, the app's settings (secrets shown only as set/unset), and your description.
        </span>
        {row("system", "System info and recent errors", "Versions, CPU/memory/disk, job queue, usage, and this instance's error log from the last week")}
        {projectId && row("logs", "Logs for this project", preview && !preview.logs ? "This instance doesn't keep a log file" : "Pipeline log lines, including model calls when they're recorded", !!preview && !preview.logs)}
        {projectId && row("previews", "Thumbnails and the selected clips' videos", clipIds.length ? "So we can see what you saw" : "Thumbnails only until you pick clips")}
        {projectId && row("allClips", "All rendered clips", preview ? `${preview.clips} clip${preview.clips === 1 ? "" : "s"} · ${mb(preview.clipsBytes)}` : <Skeleton className="mt-0.5 inline-block h-3 w-28" />)}
        {projectId && row("source", "Source video", preview ? `${mb(preview.sourceBytes)}${preview.sourceType === "url" ? " · not needed when the link still works" : " · needed to reproduce problems with uploads"}` : <Skeleton className="mt-0.5 inline-block h-3 w-40" />)}
      </fieldset>

      {/* one reserved line for notes and errors, so the buttons never move */}
      <p className={`min-h-[18px] text-xs ${error ? "text-err" : "text-ink3"}`} role={error ? "alert" : undefined}>
        {error ?? (uploadWithoutSource ? "Without the source video, problems that depend on the video itself can't be reproduced." : "")}
      </p>

      <div className="flex items-center justify-end gap-2">
        <button className="btn-ghost" disabled={busy} onClick={closeReport}>
          Cancel
        </button>
        <button className="btn-ink min-w-[10.5rem]" disabled={busy} onClick={() => void download()}>
          {busy ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" /> Preparing…
            </>
          ) : (
            "Download report"
          )}
        </button>
      </div>
    </Modal>
  );
}
