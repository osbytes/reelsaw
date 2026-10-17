import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useNavigate } from "react-router";
import { Loader2, X } from "lucide-react";
import { useTRPC } from "./trpc";
import { useSession } from "./auth";

/** POST the file to /api/upload (raw body, name in x-filename); resolves to the upload id. */
export function uploadFile(f: File, onProgress?: (p: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/upload");
    xhr.withCredentials = true;
    xhr.setRequestHeader("x-filename", encodeURIComponent(f.name));
    xhr.setRequestHeader("Content-Type", f.type || "application/octet-stream");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve((JSON.parse(xhr.responseText) as { uploadId: string }).uploadId);
      else reject(new Error(xhr.responseText || `upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("upload failed"));
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
export const isBumperFile = (f: File) => isVideo(f) || f.type.startsWith("image/") || /\.(png|jpe?g)$/i.test(f.name);

interface Job {
  key: string;
  name: string;
  pct: number;
  state: "uploading" | "creating" | "done" | "failed";
  projectId?: string;
  error?: string;
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
  const [jobs, setJobs] = useState<Job[]>([]);
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const patch = (key: string, p: Partial<Job>) => setJobs((js) => js.map((j) => (j.key === key ? { ...j, ...p } : j)));

  const startProjects = useCallback(
    (files: File[]) => {
      const list = files.filter(isVideo).map((f) => ({ f, key: `${f.name}:${f.size}:${Date.now()}:${Math.random()}` }));
      if (!list.length) return;
      setJobs((js) => [...js.filter((j) => j.state !== "done"), ...list.map(({ f, key }) => ({ key, name: f.name, pct: 0, state: "uploading" as const }))]);
      let next = 0;
      const worker = async () => {
        while (next < list.length) {
          const { f, key } = list[next++]!;
          try {
            const uploadId = await uploadFile(f, (pct) => patch(key, { pct }));
            patch(key, { state: "creating", pct: 1 });
            const p = await create.mutateAsync({ uploadId, title: f.name.replace(/\.[^.]+$/, "") });
            patch(key, { state: "done", projectId: p.id });
            void qc.invalidateQueries({ queryKey: trpc.projects.list.queryKey() });
          } catch (err) {
            patch(key, { state: "failed", error: (err as Error).message.slice(0, 160) });
          }
        }
      };
      void Promise.all([worker(), worker()]);
      nav("/");
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
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
  return (
    <Ctx.Provider value={{ startProjects, openWithFile }}>
      {children}
      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-[90] grid place-items-center bg-acc/15 p-6 backdrop-blur-[2px]">
          <div className="flex flex-col items-center gap-2 rounded-[20px] border-2 border-dashed border-acc bg-panel px-10 py-8 text-center shadow-pop">
            <b className="text-lg">{inLibrary.current ? "Drop to add to the library" : "Drop videos to start projects"}</b>
            <span className="text-sm text-ink2">{inLibrary.current ? "Videos up to 10 s and images become intros and outros." : "One video opens New project. Several start a project each with the default settings."}</span>
          </div>
        </div>
      )}
      {jobs.length > 0 && (
        <div className="fixed bottom-4 right-4 z-[75] flex w-[320px] max-w-[calc(100vw-32px)] flex-col gap-1.5 rounded-[14px] border border-line bg-panel p-3 shadow-pop">
          <div className="flex items-center gap-2">
            <b className="text-[13px]">{active ? `Uploading ${active} video${active === 1 ? "" : "s"}` : "Uploads"}</b>
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
              {j.error && <span className="text-err">{j.error}</span>}
            </div>
          ))}
        </div>
      )}
    </Ctx.Provider>
  );
}
