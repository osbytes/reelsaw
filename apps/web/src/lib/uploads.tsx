import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useNavigate } from "react-router";
import { Loader2, X } from "lucide-react";
import type { QuotaRefusal } from "@reelsaw/shared";
import { useTRPC } from "./trpc";
import { useSession } from "./auth";
import { useSystemStatus } from "./account";
import { toast } from "sonner";
import { QuotaNotice, quotaFromError } from "../components/QuotaNotice";

/** Thrown (as the rejection) when an upload is cancelled with its AbortSignal. */
export class UploadCancelled extends Error {
  constructor() {
    super("Upload cancelled.");
    this.name = "UploadCancelled";
  }
}

/** A sentence for a file over the instance's upload limit, or null when it fits (or the limit is not known yet). */
export function uploadSizeProblem(f: File, maxMb: number | undefined): string | null {
  if (!maxMb || f.size <= maxMb * 1024 * 1024) return null;
  return `${f.name} is ${Math.round(f.size / 1024 / 1024).toLocaleString()} MB, and this server accepts uploads up to ${maxMb.toLocaleString()} MB.`;
}

/** Warns before the tab closes while `active` (an upload would be lost). */
export function useLeaveWarning(active: boolean) {
  useEffect(() => {
    if (!active) return;
    const on = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", on);
    return () => window.removeEventListener("beforeunload", on);
  }, [active]);
}

/** POST the file to /api/upload (raw body, name in x-filename); resolves to the upload id. Aborting `signal` rejects with UploadCancelled. */
export function uploadFile(f: File, onProgress?: (p: number) => void, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new UploadCancelled());
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/upload");
    xhr.withCredentials = true;
    xhr.setRequestHeader("x-filename", encodeURIComponent(f.name));
    xhr.setRequestHeader("Content-Type", f.type || "application/octet-stream");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    const onAbort = () => xhr.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const done = () => signal?.removeEventListener("abort", onAbort);
    xhr.onload = () => {
      done();
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const body: unknown = JSON.parse(xhr.responseText);
          if (body && typeof body === "object" && "uploadId" in body && typeof body.uploadId === "string") return resolve(body.uploadId);
        } catch {
          /* handled below */
        }
        reject(new Error("The server answered with something that was not JSON; try again."));
      } else {
        let msg = xhr.responseText || `upload failed (${xhr.status})`;
        let quota: QuotaRefusal | undefined;
        try {
          const body = JSON.parse(xhr.responseText) as { error?: string; quota?: QuotaRefusal };
          if (body.error) msg = body.error;
          quota = body.quota;
        } catch {
          /* raw body */
        }
        reject(Object.assign(new Error(msg), { quota }));
      }
    };
    xhr.onabort = () => {
      done();
      reject(new UploadCancelled());
    };
    xhr.ontimeout = () => {
      done();
      reject(new Error("The upload timed out; check your connection and try again."));
    };
    xhr.onerror = () => {
      done();
      reject(new Error("The upload failed; check your connection and try again."));
    };
    xhr.send(f);
  });
}

const VIDEO_EXT = /\.(mp4|mov|m4v|mkv|webm|avi|mpe?g|ts)$/i;
export const isVideo = (f: File) => f.type.startsWith("video/") || VIDEO_EXT.test(f.name);

/** A file handed from the global dropzone to the New project page. */
let pending: File | null = null;
export const peekPendingFile = (): File | null => pending;
export function takePendingFile(): File | null {
  const f = pending;
  pending = null;
  return f;
}
/** Drops a handed-over file nobody took (New project closed before consuming it). */
export const clearPendingFile = () => void (pending = null);

/** An intro/outro file picked outside the Library page (⌘K, the Projects menu); the page uploads it on arrival. */
let pendingBumpers: File[] = [];
const BUMPER_EVENT = "reelsaw:bumper-files";
/** Hands files to the Library page: it picks them up on arrival, or right away if it is already open. */
export function setPendingBumperFiles(files: File[]) {
  pendingBumpers = [...pendingBumpers, ...files];
  window.dispatchEvent(new Event(BUMPER_EVENT));
}
export function takePendingBumperFiles(): File[] {
  const f = pendingBumpers;
  pendingBumpers = [];
  return f;
}
export const onBumperFiles = (fn: () => void) => {
  window.addEventListener(BUMPER_EVENT, fn);
  return () => window.removeEventListener(BUMPER_EVENT, fn);
};
export const isBumperFile = (f: File) => isVideo(f) || f.type.startsWith("image/") || /\.(png|jpe?g|webp|gif|svg)$/i.test(f.name);

interface Job {
  key: string;
  name: string;
  pct: number;
  state: "uploading" | "creating" | "done" | "failed";
  projectId?: string;
  error?: string;
  quota?: QuotaRefusal | undefined;
}

const Ctx = createContext<{ startProjects: (files: File[]) => void; openWithFile: (f: File) => void }>({ startProjects: () => {}, openWithFile: () => {} });
export const useUploads = () => useContext(Ctx);

/**
 * Global upload queue + dropzone. Dropping one video opens New project with it selected; dropping
 * several starts a project for each with the default settings (uploads run two at a time).
 */
export function UploadsProvider({ children }: { children: ReactNode }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const nav = useNavigate();
  const { pathname } = useLocation();
  // read live by the window listeners below, which are registered once
  const inLibrary = useRef(false);
  inLibrary.current = pathname === "/library";
  const { data: session } = useSession();
  const create = useMutation(trpc.projects.create.mutationOptions());
  const maxUploadMb = useSystemStatus().data?.maxUploadMb;
  const maxMbRef = useRef(maxUploadMb);
  maxMbRef.current = maxUploadMb;
  const [jobs, setJobs] = useState<Job[]>([]);
  // one controller per job, so a row (or the whole batch) can be cancelled, including files still queued
  const ctrls = useRef(new Map<string, AbortController>());
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const patch = (key: string, p: Partial<Job>) => setJobs((js) => js.map((j) => (j.key === key ? { ...j, ...p } : j)));

  const startProjects = useCallback(
    (files: File[]) => {
      const fits = files.filter(isVideo).filter((f) => {
        const problem = uploadSizeProblem(f, maxMbRef.current);
        if (problem) toast.error(problem);
        return !problem;
      });
      const list = fits.map((f) => ({ f, key: `${f.name}:${f.size}:${Date.now()}:${Math.random()}` }));
      if (!list.length) return;
      for (const { key } of list) ctrls.current.set(key, new AbortController());
      setJobs((js) => [...js.filter((j) => j.state !== "done"), ...list.map(({ f, key }) => ({ key, name: f.name, pct: 0, state: "uploading" as const }))]);
      let next = 0;
      const worker = async () => {
        while (next < list.length) {
          const { f, key } = list[next++]!;
          const ctrl = ctrls.current.get(key)!;
          if (ctrl.signal.aborted) continue;
          try {
            const uploadId = await uploadFile(f, (pct) => patch(key, { pct }), ctrl.signal);
            patch(key, { state: "creating", pct: 1 });
            const p = await create.mutateAsync({ uploadId, title: f.name.replace(/\.[^.]+$/, "") });
            patch(key, { state: "done", projectId: p.id });
            void qc.invalidateQueries({ queryKey: trpc.projects.pathKey() });
          } catch (err) {
            if (err instanceof UploadCancelled) continue; // the row was removed by the cancel
            patch(key, { state: "failed", error: (err as Error).message, quota: quotaFromError(err) });
          } finally {
            ctrls.current.delete(key);
          }
        }
      };
      void Promise.all([worker(), worker()]);
      nav("/");
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  // A row in "creating" is past the upload and the projects.create mutation cannot be aborted: the project will
  // appear, so its row (and Open link) stays. Aborting its controller is harmless (only the upload reads the signal).
  const cancel = useCallback((key: string) => {
    ctrls.current.get(key)?.abort();
    setJobs((js) => js.filter((j) => j.key !== key || j.state === "creating"));
  }, []);
  const cancelAll = useCallback(() => {
    for (const c of ctrls.current.values()) c.abort();
    setJobs((js) => js.filter((j) => j.state === "done" || j.state === "failed" || j.state === "creating"));
  }, []);
  const dismiss = useCallback((key: string) => setJobs((js) => js.filter((j) => j.key !== key)), []);
  const openWithFile = useCallback(
    (f: File) => {
      pending = f;
      nav("/new", { state: { file: Date.now() } });
    },
    [nav],
  );

  // whole-window dropzone (signed in only)
  useEffect(() => {
    if (!session) return;
    const hasFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes("Files");
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current++;
      setDragging(true);
    };
    const over = (e: DragEvent) => hasFiles(e) && e.preventDefault();
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (!depth.current) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      // a drop target inside the page (e.g. the New project picker) handles its own files
      if ((e.target as HTMLElement | null)?.closest?.("[data-own-drop]")) return;
      if (inLibrary.current) {
        const picked = [...(e.dataTransfer?.files ?? [])].filter(isBumperFile);
        if (picked.length) setPendingBumperFiles(picked);
        return;
      }
      const files = [...(e.dataTransfer?.files ?? [])].filter(isVideo);
      if (files.length === 1) openWithFile(files[0]!);
      else if (files.length > 1) startProjects(files);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, [session, openWithFile, startProjects]);

  const active = jobs.filter((j) => j.state === "uploading" || j.state === "creating").length;
  useLeaveWarning(active > 0);
  return (
    <Ctx.Provider value={{ startProjects, openWithFile }}>
      {children}
      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-[90] grid place-items-center bg-acc/15 p-6 backdrop-blur-[2px]">
          <div className="flex flex-col items-center gap-2 rounded-[20px] border-2 border-dashed border-acc bg-panel px-10 py-8 text-center shadow-pop">
            <b className="text-lg">{inLibrary.current ? "Drop to add to the library" : "Drop videos to start projects"}</b>
            <span className="text-sm text-ink2">{inLibrary.current ? "Videos and images (PNG, JPG, WebP, GIF, SVG) are added to the library." : "One video opens New project. Several start a project each with the default settings."}</span>
          </div>
        </div>
      )}
      {jobs.length > 0 && (
        <div className="fixed bottom-4 right-4 z-[75] flex w-[320px] max-w-[calc(100vw-32px)] flex-col gap-1.5 rounded-[14px] border border-line bg-panel p-3 shadow-pop">
          <div className="flex items-center gap-2">
            <b className="text-[13px]">{active ? `Uploading ${active} video${active === 1 ? "" : "s"}` : "Uploads"}</b>
            {active > 1 && (
              <button className="btn-quiet ml-auto px-2 py-0.5 text-xs" onClick={cancelAll}>
                Cancel all
              </button>
            )}
            {!active && (
              <button className="ml-auto text-ink3 hover:text-ink" onClick={() => setJobs([])} aria-label="Dismiss uploads">
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          {jobs.map((j) => (
            <div key={j.key} className="flex flex-col gap-1 text-xs">
              <div className="flex items-center gap-2">
                {j.state === "uploading" || j.state === "creating" ? <Loader2 className="h-3 w-3 shrink-0 animate-spin text-acc-text" /> : <span className={`font-mono ${j.state === "done" ? "text-ok" : "text-err"}`}>{j.state === "done" ? "●" : "▲"}</span>}
                <span className="min-w-0 flex-1 truncate">{j.name}</span>
                {j.state === "uploading" && (
                  <button className="text-ink3 hover:text-ink" onClick={() => cancel(j.key)} aria-label={`Cancel upload of ${j.name}`} title="Cancel upload">
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
                {j.state === "failed" && (
                  <button className="text-ink3 hover:text-ink" onClick={() => dismiss(j.key)} aria-label={`Dismiss ${j.name}`} title="Dismiss">
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
                {j.state === "done" && j.projectId ? (
                  <Link to={`/p/${j.projectId}`} className="font-semibold text-acc-text no-underline">
                    Open
                  </Link>
                ) : (
                  <span className="font-mono text-ink3">{j.state === "uploading" ? `${Math.round(j.pct * 100)}%` : j.state === "creating" ? "starting" : "failed"}</span>
                )}
              </div>
              {j.state === "uploading" && (
                <div className="h-1 overflow-hidden rounded-full bg-sunk">
                  <div className="h-full bg-acc transition-all" style={{ width: `${j.pct * 100}%` }} />
                </div>
              )}
              {j.error && <QuotaNotice message={j.error} quota={j.quota} />}
            </div>
          ))}
        </div>
      )}
    </Ctx.Provider>
  );
}
