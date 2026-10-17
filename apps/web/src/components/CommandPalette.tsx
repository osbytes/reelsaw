import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFuzzy, Highlight } from "../lib/fuzzy";
import { useNavigate } from "react-router";
import { ChevronLeft, Download, ExternalLink, Film, FolderOpen, LifeBuoy, Link2, MoreHorizontal, Moon, Pencil, Play, Plus, RefreshCw, RotateCcw, Search, Settings, Sparkles, Trash2, Upload } from "lucide-react";
import { openReportHere } from "../lib/report";
import { useTRPC } from "../lib/trpc";
import { useSession } from "../lib/auth";
import { useTheme } from "../lib/theme";
import { useUploads } from "../lib/uploads";
import { useToast } from "../lib/toast";
import { extractUrls, isOnlyUrls, linkKey } from "../lib/links";
import { ago } from "../lib/time";
import { ScrollArea } from "./scroll-area";
import { ConfirmDialog, StatusText } from "./ui";
import { formatTime } from "@reelsaw/shared";

const MOD = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
/** Whitespace and newlines collapse to single spaces so a pasted list of links survives a one-line input. */
const oneLine = (s: string) => s.trim().split(/\s+/).join(" ");

const Ctx = createContext<(q?: string) => void>(() => {});
export const useCommandPalette = () => useContext(Ctx);

/** What the action list (→) is about. */
type Target = { kind: "project" | "clip"; id: string };

interface Item {
  key: string;
  group: string;
  label: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  thumb?: string | null;
  danger?: boolean;
  /** → / Tab / the ⋯ button open this item's action list */
  actions?: Target;
  run: () => void;
}

/**
 * ⌘K: jump to a project or clip, run an action, or paste a video link to start a project.
 * A link (or a list of links) pasted anywhere outside a text field opens it too.
 */
export function CommandPaletteProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const { data: session } = useSession();
  const show = (initial = "") => {
    setQ(initial);
    setOpen(true);
  };
  useEffect(() => {
    if (!session) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
        setQ("");
      }
    };
    const onPaste = (e: ClipboardEvent) => {
      const el = e.target as HTMLElement;
      if (el.closest("input, textarea, select, [contenteditable]")) return;
      const text = e.clipboardData?.getData("text") ?? "";
      if (isOnlyUrls(text)) {
        e.preventDefault();
        show(oneLine(text));
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("paste", onPaste);
    };
  }, [session]);
  return (
    <Ctx.Provider value={show}>
      {children}
      {session && <Palette open={open} onOpenChange={setOpen} q={q} setQ={setQ} />}
    </Ctx.Provider>
  );
}

function download(href: string) {
  const a = Object.assign(document.createElement("a"), { href, download: "" });
  document.body.append(a);
  a.click();
  a.remove();
}

function Palette({ open, onOpenChange, q, setQ }: { open: boolean; onOpenChange: (o: boolean) => void; q: string; setQ: (s: string) => void }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const nav = useNavigate();
  const toast = useToast();
  const [, toggleTheme] = useTheme();
  const { startProjects, openWithFile } = useUploads();
  const fileRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const retry = useMutation(trpc.projects.retry.mutationOptions());
  const refine = useMutation(trpc.projects.refine.mutationOptions());
  const del = useMutation(trpc.projects.delete.mutationOptions());
  const rerender = useMutation(trpc.clips.rerender.mutationOptions());
  const create = useMutation(trpc.projects.create.mutationOptions());

  // one small index of every project and clip, fuzzy-matched locally as you type
  const indexQ = useQuery({ ...trpc.searchIndex.queryOptions(), enabled: open, staleTime: 30_000 });
  const index = indexQ.data;
  type Proj = NonNullable<typeof index>["projects"][number];
  type ClipRow = NonNullable<typeof index>["clips"][number];
  const fuse = useMemo(() => {
    if (!index) return null;
    return {
      projects: createFuzzy(index.projects, [{ name: "title", weight: 1 }]),
      clips: createFuzzy(index.clips, [{ name: "title", weight: 3 }, { name: "hook", weight: 1.5 }, { name: "projectTitle", weight: 1 }, { name: "caption", weight: 0.6 }]),
    };
  }, [index]);
  // per-project clip facts, counted client-side from the same index
  const stats = useMemo(() => {
    const m = new Map<string, { clips: number; done: number; failed: ClipRow[] }>();
    for (const c of index?.clips ?? []) {
      const s = m.get(c.projectId) ?? { clips: 0, done: 0, failed: [] };
      s.clips++;
      if (c.status === "done") s.done++;
      if (c.status === "failed") s.failed.push(c);
      m.set(c.projectId, s);
    }
    return m;
  }, [index]);
  const failedClips = useMemo(() => (index?.clips ?? []).filter((c) => c.status === "failed"), [index]);
  const failedProjects = useMemo(() => (index?.projects ?? []).filter((p) => p.status === "failed"), [index]);

  const [cursor, setCursor] = useState(0);
  const [target, setTarget] = useState<Target | null>(null);
  const [confirm, setConfirm] = useState<null | { kind: "refine" | "delete"; id: string; title: string }>(null);
  const savedQ = useRef("");
  const go = (fn: () => void) => () => {
    onOpenChange(false);
    fn();
  };

  const refresh = (projectId?: string) => {
    void qc.invalidateQueries({ queryKey: trpc.searchIndex.queryKey() });
    void qc.invalidateQueries({ queryKey: trpc.projects.list.queryKey() });
    if (projectId) void qc.invalidateQueries({ queryKey: trpc.projects.get.queryKey({ id: projectId }) });
    else void qc.invalidateQueries({ queryKey: trpc.projects.get.pathKey() });
  };
  /** Runs one mutation after the palette has closed; says in plain words how it went. */
  const act = (done: string, failed: string, fn: () => Promise<unknown>, projectId?: string) =>
    go(() => {
      fn().then(
        () => (refresh(projectId), toast(done)),
        (err: Error) => toast(`${failed}: ${err.message.slice(0, 120)}`),
      );
    });
  /** Runs a mutation per id, one after another, and reports how many worked. */
  const each = async <T,>(rows: T[], fn: (row: T) => Promise<unknown>) => {
    let ok = 0;
    let firstError = "";
    for (const r of rows) {
      try {
        await fn(r);
        ok++;
      } catch (err) {
        firstError ||= (err as Error).message;
      }
    }
    return { ok, failed: rows.length - ok, firstError };
  };
  const startFromLinks = (urls: string[], skipped: number) =>
    go(() => {
      nav("/");
      void (async () => {
        let ok = 0;
        let firstError = "";
        for (const [i, sourceUrl] of urls.entries()) {
          toast(`Starting project ${i + 1} of ${urls.length}…`);
          try {
            await create.mutateAsync({ sourceUrl });
            ok++;
          } catch (err) {
            firstError ||= (err as Error).message;
          }
        }
        refresh();
        const parts = [`Started ${plural(ok, "project")}`];
        if (skipped) parts.push(`${skipped} already existed`);
        if (ok < urls.length) parts.push(`${urls.length - ok} failed${firstError ? ` (${firstError.slice(0, 80)})` : ""}`);
        toast(parts.join(" · "));
      })();
    });

  // ----- row content -----
  const projectHint = (p: Proj): ReactNode => {
    const n = stats.get(p.id)?.clips ?? 0;
    return (
      <>
        <StatusText status={p.status} />
        {p.durationSec ? ` · ${formatTime(p.durationSec)}` : ""} · {plural(n, "clip")} · {ago(p.updatedAt)}
      </>
    );
  };
  const clipHint = (c: ClipRow, snippet?: ReactNode): ReactNode => (
    <>
      <StatusText status={c.status} /> · <span className="font-mono">{formatTime(Math.max(0, c.endSec - c.startSec))}</span> · {snippet ?? c.projectTitle} · <span className="font-mono">@{formatTime(c.startSec)}</span>
    </>
  );
  const projectItem = (p: Proj, group: string, label: ReactNode = p.title): Item => ({ key: `p-${p.id}`, group, thumb: p.thumbnailUrl, label, hint: projectHint(p), actions: { kind: "project", id: p.id }, run: go(() => nav(`/p/${p.id}`)) });

  const linkMode = isOnlyUrls(q);
  const urls = useMemo(() => (linkMode ? extractUrls(q) : []), [q, linkMode]);

  const items: Item[] = useMemo(() => {
    const out: Item[] = [];
    const ql = q.trim();
    const d = index;

    // ----- an item's own action list -----
    if (target) {
      const acts: Item[] = [];
      if (target.kind === "project") {
        const p = d?.projects.find((x) => x.id === target.id);
        if (!p) return out;
        const s = stats.get(p.id);
        const A = (key: string, label: string, icon: ReactNode, run: () => void, hint?: string, danger?: boolean): Item => ({ key: `ta-${key}`, group: "Actions", label, icon, hint, danger, run });
        acts.push(A("open", "Open", <ExternalLink className="h-4 w-4" />, go(() => nav(`/p/${p.id}`))));
        if (s?.done) acts.push(A("export", "Export zip", <Download className="h-4 w-4" />, go(() => download(`/api/projects/${p.id}/export.zip`)), `${plural(s.done, "rendered clip")} with paste-ready metadata`));
        if (p.status === "failed" || p.status === "done") acts.push(A("resume", "Resume pipeline", <Play className="h-4 w-4" />, act("Pipeline resumed", "Couldn’t resume", () => retry.mutateAsync({ id: p.id }), p.id), "From the last stage that didn’t finish"));
        if (s?.failed.length)
          acts.push(
            A(
              "retry-clips",
              `Retry failed clips (${s.failed.length})`,
              <RotateCcw className="h-4 w-4" />,
              act(`Retrying ${plural(s.failed.length, "failed clip")}`, "Couldn’t retry", () => Promise.all(s.failed.map((c) => rerender.mutateAsync({ id: c.id }))), p.id),
            ),
          );
        if (p.status === "done" || p.status === "failed") acts.push(A("refine", "Re-run refine", <Sparkles className="h-4 w-4" />, go(() => setConfirm({ kind: "refine", id: p.id, title: p.title })), "Names, disfluencies, scene changes"));
        acts.push(A("delete", "Delete project", <Trash2 className="h-4 w-4" />, go(() => setConfirm({ kind: "delete", id: p.id, title: p.title })), "Removes the source, transcript and every clip", true));
      } else {
        const c = d?.clips.find((x) => x.id === target.id);
        if (!c) return out;
        const A = (key: string, label: string, icon: ReactNode, run: () => void, hint?: string): Item => ({ key: `ta-${key}`, group: "Actions", label, icon, hint, run });
        acts.push(A("open", "Open in project", <ExternalLink className="h-4 w-4" />, go(() => nav(`/p/${c.projectId}#clip=${c.id}`))));
        acts.push(A("edit", "Edit clip", <Pencil className="h-4 w-4" />, go(() => nav(`/p/${c.projectId}/clips/${c.id}`))));
        acts.push(A("rerender", "Re-render", <RefreshCw className="h-4 w-4" />, act("Re-rendering the clip", "Couldn’t re-render", () => rerender.mutateAsync({ id: c.id }), c.projectId)));
        if (c.videoUrl && c.status === "done") acts.push(A("download", "Download clip", <Download className="h-4 w-4" />, go(() => download(`${c.videoUrl}?download`)), "The rendered mp4"));
      }
      return ql ? createFuzzy(acts, ["label", "hint"], { threshold: 0.4, minMatchCharLength: 1 }).filter(ql) : acts;
    }

    // ----- a link, or a list of links: act on what already exists, otherwise start -----
    if (linkMode) {
      const have = new Map((d?.projects ?? []).filter((p) => p.sourceUrl).map((p) => [linkKey(p.sourceUrl!), p]));
      if (urls.length === 1) {
        const existing = have.get(linkKey(urls[0]!));
        if (existing) out.push(projectItem(existing, "Already in your projects", `Open ${existing.title}`));
        out.push({ key: "new-url", group: "Start", icon: <Link2 className="h-4 w-4" />, label: "New project from this link", hint: <span className="truncate font-mono">{urls[0]}</span>, run: go(() => nav(`/new?url=${encodeURIComponent(urls[0]!)}`)) });
      } else {
        const fresh: string[] = [];
        const dupes = new Map<string, Proj>();
        const seen = new Set<string>();
        for (const u of urls) {
          const k = linkKey(u);
          if (seen.has(k)) continue;
          seen.add(k);
          const e = have.get(k);
          if (e) dupes.set(e.id, e);
          else fresh.push(u);
        }
        if (fresh.length)
          out.push({
            key: "many-url",
            group: "Start",
            icon: <Link2 className="h-4 w-4" />,
            label: `Start ${plural(fresh.length, "project")} from these links`,
            hint: dupes.size ? `${dupes.size} already exist and are skipped · default settings` : "default settings, one project per link",
            run: startFromLinks(fresh, dupes.size),
          });
        for (const p of dupes.values()) out.push(projectItem(p, "Already exist", `Already exists: ${p.title}`));
      }
      return out;
    }

    const actions: Item[] = [
      { key: "a-new", group: "Actions", icon: <Plus className="h-4 w-4" />, label: "New project", hint: "paste a link or upload", run: go(() => nav("/new")) },
      { key: "a-upload", group: "Actions", icon: <Upload className="h-4 w-4" />, label: "Upload videos…", hint: "several start a project each", run: () => fileRef.current?.click() },
      { key: "a-projects", group: "Actions", icon: <FolderOpen className="h-4 w-4" />, label: "Go to projects", run: go(() => nav("/")) },
      { key: "a-settings", group: "Actions", icon: <Settings className="h-4 w-4" />, label: "Go to settings", run: go(() => nav("/settings")) },
      { key: "a-theme", group: "Actions", icon: <Moon className="h-4 w-4" />, label: "Toggle light / dark theme", run: go(toggleTheme) },
      { key: "a-report", group: "Actions", icon: <LifeBuoy className="h-4 w-4" />, label: "Report an issue…", hint: "bug, feedback · !", run: go(openReportHere) },
    ];
    // global commands only appear when there is something for them to do
    if (failedClips.length)
      actions.unshift({
        key: "a-retry-clips",
        group: "Actions",
        icon: <RotateCcw className="h-4 w-4" />,
        label: `Retry all failed clips (${failedClips.length})`,
        hint: `across ${plural(new Set(failedClips.map((c) => c.projectId)).size, "project")}`,
        run: go(() => {
          void each(failedClips, (c) => rerender.mutateAsync({ id: c.id })).then((r) => {
            refresh();
            toast(r.failed ? `Retrying ${plural(r.ok, "clip")} · ${r.failed} couldn’t be queued${r.firstError ? ` (${r.firstError.slice(0, 80)})` : ""}` : `Retrying ${plural(r.ok, "failed clip")}`);
          });
        }),
      });
    if (failedProjects.length)
      actions.unshift({
        key: "a-resume-projects",
        group: "Actions",
        icon: <Play className="h-4 w-4" />,
        label: `Resume failed projects (${failedProjects.length})`,
        hint: "each from the last stage that didn’t finish",
        run: go(() => {
          void each(failedProjects, (p) => retry.mutateAsync({ id: p.id })).then((r) => {
            refresh();
            toast(r.failed ? `Resumed ${plural(r.ok, "project")} · ${r.failed} couldn’t be resumed${r.firstError ? ` (${r.firstError.slice(0, 80)})` : ""}` : `Resumed ${plural(r.ok, "failed project")}`);
          });
        }),
      });
    if (!ql) {
      for (const p of (d?.projects ?? []).slice(0, 6)) out.push(projectItem(p, "Recent projects"));
      return [...out, ...actions];
    }
    const actionFuse = createFuzzy(actions, ["label", "hint"], { threshold: 0.4, minMatchCharLength: 1 });
    for (const r of actionFuse.search(ql, 3)) out.push({ ...r.item, label: <Highlight text={String(r.item.label)} matches={r.matches} k="label" /> });
    if (fuse) {
      for (const r of fuse.projects.search(ql).slice(0, 6)) out.push(projectItem(r.item, "Projects", <Highlight text={r.item.title} matches={r.matches} k="title" />));
      for (const r of fuse.clips.search(ql).slice(0, 10)) {
        const c = r.item;
        const via = r.matches?.find((m) => m.key !== "title");
        out.push({
          key: `c-${c.id}`,
          group: "Clips",
          thumb: c.thumbnailUrl,
          icon: <Film className="h-4 w-4" />,
          label: <Highlight text={c.title || "Untitled clip"} matches={r.matches} k="title" />,
          // show where the match was when it wasn't the title: the hook or caption snippet
          hint: clipHint(c, via && (via.key === "hook" || via.key === "caption") && typeof via.value === "string" ? <Highlight text={via.value} matches={[via]} k={via.key} /> : undefined),
          actions: { kind: "clip", id: c.id },
          run: go(() => nav(`/p/${c.projectId}#clip=${c.id}`)),
        });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, linkMode, urls, target, index, fuse, stats, failedClips, failedProjects]);

  useEffect(() => setCursor(0), [q, target]);
  useEffect(() => {
    if (!open) setTarget(null);
  }, [open]);
  // the item an open action list belongs to was deleted: back to the list
  useEffect(() => {
    if (target && index && !(target.kind === "project" ? index.projects.some((p) => p.id === target.id) : index.clips.some((c) => c.id === target.id))) setTarget(null);
  }, [target, index]);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const enter = (t: Target) => {
    savedQ.current = q;
    setQ("");
    setTarget(t);
    inputRef.current?.focus();
  };
  const back = () => {
    setTarget(null);
    setQ(savedQ.current);
    inputRef.current?.focus();
  };
  const crumb = target ? (target.kind === "project" ? index?.projects.find((p) => p.id === target.id)?.title : index?.clips.find((c) => c.id === target.id)?.title || "Untitled clip") : null;

  let lastGroup = "";
  return (
    <>
      <Dialog.Root open={open} onOpenChange={onOpenChange}>
        <Dialog.Portal>
          {/* z-[85]/[86] sit above the confirm dialogs (z-[70]/[71]); the palette closes before a confirm opens */}
          <Dialog.Overlay className="fixed inset-0 z-[85] bg-black/40" />
          <Dialog.Content
            className="fixed left-1/2 top-[12vh] z-[86] flex w-[min(640px,calc(100vw-24px))] -translate-x-1/2 flex-col overflow-hidden rounded-[18px] border border-line bg-panel text-ink shadow-pop outline-none"
            aria-describedby={undefined}
            onEscapeKeyDown={(e) => {
              if (target) {
                e.preventDefault();
                back();
              }
            }}
          >
            <Dialog.Title className="sr-only">Search and commands</Dialog.Title>
            <div className="flex items-center gap-2.5 border-b border-line px-4">
              {target ? (
                <button type="button" onClick={back} className="flex h-7 max-w-[45%] shrink-0 items-center gap-1 rounded-[8px] bg-sunk pl-1.5 pr-2.5 text-xs font-semibold text-ink2 hover:text-ink" aria-label="Back to results" title="Back (←)">
                  <ChevronLeft className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{crumb}</span>
                </button>
              ) : (
                <Search className="h-4 w-4 shrink-0 text-ink3" />
              )}
              <input
                ref={inputRef}
                autoFocus
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onPaste={(e) => {
                  // a one-line input would drop the newlines between pasted links: keep them as spaces
                  const text = e.clipboardData.getData("text");
                  if (!/[\r\n]/.test(text)) return;
                  e.preventDefault();
                  const el = e.currentTarget;
                  const a = el.selectionStart ?? q.length;
                  const b = el.selectionEnd ?? q.length;
                  setQ(`${q.slice(0, a)}${oneLine(text)}${q.slice(b)}`.replace(/ {2,}/g, " "));
                }}
                onKeyDown={(e) => {
                  const el = e.currentTarget;
                  const atEnd = el.selectionStart === el.value.length && el.selectionEnd === el.value.length;
                  const atStart = el.selectionStart === 0 && el.selectionEnd === 0;
                  const cur = items[cursor];
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setCursor((c) => Math.min(items.length - 1, c + 1));
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setCursor((c) => Math.max(0, c - 1));
                  } else if (e.key === "Enter") {
                    e.preventDefault();
                    cur?.run();
                  } else if ((e.key === "ArrowRight" && atEnd) || (e.key === "Tab" && !e.shiftKey)) {
                    // only caret-neutral moments: the caret is at the end, so → has nothing else to do
                    if (!target && cur?.actions) {
                      e.preventDefault();
                      enter(cur.actions);
                    }
                  } else if (target && ((e.key === "ArrowLeft" && atStart) || (e.key === "Backspace" && q === ""))) {
                    e.preventDefault();
                    back();
                  }
                }}
                placeholder={target ? "Filter actions…" : "Search projects and clips, or paste video links…"}
                className="h-[52px] min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-ink3 focus-visible:outline-none"
                aria-label={target ? "Filter actions" : "Search"}
              />
              <span className="kbd">esc</span>
            </div>
            <ScrollArea className="max-h-[min(460px,60vh)]">
              <div ref={listRef} className="flex flex-col p-1.5">
                {items.length === 0 && <div className="px-3 py-8 text-center text-sm text-ink3">{indexQ.isLoading ? "Loading…" : "Nothing found"}</div>}
                {items.map((it, i) => {
                  const head = it.group !== lastGroup ? it.group : null;
                  lastGroup = it.group;
                  const sel = i === cursor;
                  return (
                    <div key={it.key}>
                      {head && <div className="px-2.5 pb-1 pt-2.5 text-[11px] font-semibold text-ink3">{head}</div>}
                      <div data-idx={i} onMouseMove={() => setCursor(i)} className={`flex w-full items-center gap-1 rounded-[10px] ${sel ? "bg-sunk" : ""}`}>
                        <button onClick={it.run} className="flex min-w-0 flex-1 items-center gap-3 rounded-[10px] px-2.5 py-2 text-left">
                          {it.thumb ? (
                            <img src={it.thumb} alt="" referrerPolicy="no-referrer" className={`shrink-0 rounded-[6px] object-cover ${it.group === "Clips" ? "h-9 w-[20px]" : "h-8 w-[56px]"}`} />
                          ) : (
                            <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-[8px] bg-sunk ${it.danger ? "text-err" : "text-ink2"}`}>{it.icon ?? <FolderOpen className="h-4 w-4" />}</span>
                          )}
                          <span className="min-w-0 flex-1">
                            <span className={`block truncate text-[13px] font-semibold ${it.danger ? "text-err" : ""}`}>{it.label}</span>
                            {/* the hint line is always reserved so rows keep one height */}
                            <span className="block h-4 truncate text-xs leading-4 text-ink3">{it.hint}</span>
                          </span>
                          <span className={`kbd shrink-0 ${sel ? "" : "invisible"}`}>↵</span>
                        </button>
                        {it.actions && !target ? (
                          <button
                            type="button"
                            tabIndex={-1}
                            onClick={() => enter(it.actions!)}
                            className="mr-1 grid h-8 w-8 shrink-0 place-items-center rounded-[8px] text-ink3 hover:bg-line hover:text-ink"
                            aria-label={`Actions for ${typeof it.label === "string" ? it.label : "this item"}`}
                            title="Actions (→)"
                          >
                            <MoreHorizontal className="h-4 w-4" />
                          </button>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </ScrollArea>
            <div className="flex items-center gap-3 overflow-hidden whitespace-nowrap border-t border-line px-4 py-2 text-[11px] text-ink3">
              <span>
                <span className="kbd">↑↓</span> move
              </span>
              <span>
                <span className="kbd">↵</span> {target ? "run" : "open"}
              </span>
              {target ? (
                <span>
                  <span className="kbd">←</span> back
                </span>
              ) : (
                <span>
                  <span className="kbd">→</span> actions
                </span>
              )}
              <span className="ml-auto hidden sm:inline">{target ? "esc goes back" : `Drop videos anywhere to start projects · ${MOD}K`}</span>
            </div>
            <input
              ref={fileRef}
              type="file"
              multiple
              accept="video/*,.mkv,.mov,.mp4,.webm"
              className="hidden"
              onChange={(e) => {
                const files = [...(e.target.files ?? [])];
                e.target.value = "";
                onOpenChange(false);
                if (files.length === 1) openWithFile(files[0]!);
                else if (files.length > 1) startProjects(files);
              }}
            />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <ConfirmDialog
        open={confirm?.kind === "refine"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Re-run refine?"
        body={`Names, disfluencies and scene changes are detected again for “${confirm?.title ?? ""}”. Your accepted and rejected fixes may be replaced.`}
        confirm="Re-run refine"
        onConfirm={() => {
          const c = confirm!;
          refine.mutateAsync({ id: c.id }).then(
            () => (refresh(c.id), toast("Re-running refine")),
            (err: Error) => toast(`Couldn’t re-run refine: ${err.message.slice(0, 120)}`),
          );
        }}
      />
      <ConfirmDialog
        open={confirm?.kind === "delete"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Delete this project?"
        body={`“${confirm?.title ?? ""}”: the source video, transcript and every clip are removed. This can’t be undone.`}
        confirm="Delete project"
        danger
        onConfirm={() => {
          const c = confirm!;
          del.mutateAsync({ id: c.id }).then(
            () => (refresh(), toast("Project deleted")),
            (err: Error) => toast(`Couldn’t delete: ${err.message.slice(0, 120)}`),
          );
        }}
      />
    </>
  );
}
