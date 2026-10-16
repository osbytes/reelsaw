import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { Film, FolderOpen, Link2, Moon, Plus, Search, Settings, Upload } from "lucide-react";
import { useTRPC } from "../lib/trpc";
import { useSession } from "../lib/auth";
import { useTheme } from "../lib/theme";
import { useUploads } from "../lib/uploads";
import { ScrollArea } from "./scroll-area";
import { StatusText } from "./ui";
import { formatTime } from "@reelsaw/shared";

const MOD = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";
const isUrl = (s: string) => /^https?:\/\/\S+\.\S+/.test(s.trim());

const Ctx = createContext<(q?: string) => void>(() => {});
export const useCommandPalette = () => useContext(Ctx);

interface Item {
  key: string;
  group: string;
  label: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  thumb?: string | null;
  run: () => void;
}

/**
 * ⌘K: jump to a project or clip, run an action, or paste a video link to start a project.
 * A link pasted anywhere outside a text field opens it too.
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
      if (isUrl(text)) {
        e.preventDefault();
        show(text.trim());
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

function Palette({ open, onOpenChange, q, setQ }: { open: boolean; onOpenChange: (o: boolean) => void; q: string; setQ: (s: string) => void }) {
  const trpc = useTRPC();
  const nav = useNavigate();
  const [, toggleTheme] = useTheme();
  const { startProjects, openWithFile } = useUploads();
  const fileRef = useRef<HTMLInputElement>(null);
  const [debounced, setDebounced] = useState(q);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(q.trim()), 140);
    return () => clearTimeout(id);
  }, [q]);
  const url = isUrl(q);
  const projectsQ = useQuery({ ...trpc.projects.list.queryOptions(), enabled: open });
  const searchQ = useQuery({ ...trpc.search.queryOptions({ q: debounced || "_" }), enabled: open && debounced.length >= 2 && !url, placeholderData: (prev) => prev });
  const [cursor, setCursor] = useState(0);
  const go = (fn: () => void) => () => {
    onOpenChange(false);
    fn();
  };

  const items: Item[] = useMemo(() => {
    const out: Item[] = [];
    const ql = q.trim().toLowerCase();
    if (url) out.push({ key: "new-url", group: "Start", icon: <Link2 className="h-4 w-4" />, label: "New project from this link", hint: <span className="truncate font-mono">{q.trim()}</span>, run: go(() => nav(`/new?url=${encodeURIComponent(q.trim())}`)) });
    const actions: Item[] = [
      { key: "a-new", group: "Actions", icon: <Plus className="h-4 w-4" />, label: "New project", hint: "paste a link or upload", run: go(() => nav("/new")) },
      { key: "a-upload", group: "Actions", icon: <Upload className="h-4 w-4" />, label: "Upload videos…", hint: "several start a project each", run: () => fileRef.current?.click() },
      { key: "a-projects", group: "Actions", icon: <FolderOpen className="h-4 w-4" />, label: "Go to projects", run: go(() => nav("/")) },
      { key: "a-settings", group: "Actions", icon: <Settings className="h-4 w-4" />, label: "Go to settings", run: go(() => nav("/settings")) },
      { key: "a-theme", group: "Actions", icon: <Moon className="h-4 w-4" />, label: "Toggle light / dark theme", run: go(toggleTheme) },
    ];
    if (url) return out;
    if (!ql) {
      for (const p of (projectsQ.data ?? []).slice(0, 6))
        out.push({ key: `p-${p.id}`, group: "Recent projects", thumb: p.sourceThumbnailUrl ?? p.thumbnailUrl, label: p.title, hint: <StatusText status={p.status} />, run: go(() => nav(`/p/${p.id}`)) });
      return [...out, ...actions];
    }
    out.push(...actions.filter((a) => String(a.label).toLowerCase().includes(ql)));
    const projects = searchQ.data?.projects ?? (projectsQ.data ?? []).filter((p) => p.title.toLowerCase().includes(ql)).slice(0, 8);
    for (const p of projects) {
      const full = projectsQ.data?.find((x) => x.id === p.id);
      out.push({ key: `p-${p.id}`, group: "Projects", thumb: full?.sourceThumbnailUrl ?? full?.thumbnailUrl, label: p.title, hint: <StatusText status={p.status} />, run: go(() => nav(`/p/${p.id}`)) });
    }
    for (const c of searchQ.data?.clips ?? [])
      out.push({
        key: `c-${c.id}`,
        group: "Clips",
        thumb: c.thumbnailUrl,
        icon: <Film className="h-4 w-4" />,
        label: c.title || "Untitled clip",
        hint: (
          <span className="truncate">
            #{c.index + 1} · {c.projectTitle} · <span className="font-mono">{formatTime(c.startSec)}</span>
          </span>
        ),
        run: go(() => nav(`/p/${c.projectId}#clip=${c.id}`)),
      });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, url, projectsQ.data, searchQ.data]);

  useEffect(() => setCursor(0), [q]);
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${cursor}"]`)?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  let lastGroup = "";
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[85] bg-black/40" />
        <Dialog.Content
          className="fixed left-1/2 top-[12vh] z-[86] flex w-[min(640px,calc(100vw-24px))] -translate-x-1/2 flex-col overflow-hidden rounded-[18px] border border-line bg-panel text-ink shadow-pop outline-none"
          aria-describedby={undefined}
        >
          <Dialog.Title className="sr-only">Search and commands</Dialog.Title>
          <div className="flex items-center gap-2.5 border-b border-line px-4">
            <Search className="h-4 w-4 shrink-0 text-ink3" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setCursor((c) => Math.min(items.length - 1, c + 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setCursor((c) => Math.max(0, c - 1));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  items[cursor]?.run();
                }
              }}
              placeholder="Search projects and clips, or paste a video link…"
              className="h-[52px] min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-ink3"
              aria-label="Search"
            />
            <span className="kbd">esc</span>
          </div>
          <ScrollArea className="max-h-[min(460px,60vh)]">
            <div ref={listRef} className="flex flex-col p-1.5">
              {items.length === 0 && <div className="px-3 py-8 text-center text-sm text-ink3">{searchQ.isFetching ? "Searching…" : "Nothing found"}</div>}
              {items.map((it, i) => {
                const head = it.group !== lastGroup ? it.group : null;
                lastGroup = it.group;
                return (
                  <div key={it.key}>
                    {head && <div className="px-2.5 pb-1 pt-2.5 text-[11px] font-semibold text-ink3">{head}</div>}
                    <button
                      data-idx={i}
                      onMouseMove={() => setCursor(i)}
                      onClick={it.run}
                      className={`flex w-full items-center gap-3 rounded-[10px] px-2.5 py-2 text-left ${i === cursor ? "bg-sunk" : ""}`}
                    >
                      {it.thumb ? (
                        <img src={it.thumb} alt="" referrerPolicy="no-referrer" className={`shrink-0 rounded-[6px] object-cover ${it.group === "Clips" ? "h-9 w-[20px]" : "h-8 w-[56px]"}`} />
                      ) : (
                        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-[8px] bg-sunk text-ink2">{it.icon ?? <FolderOpen className="h-4 w-4" />}</span>
                      )}
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-semibold">{it.label}</span>
                        {it.hint && <span className="block truncate text-xs text-ink3">{it.hint}</span>}
                      </span>
                      {i === cursor && <span className="kbd text-[10px]">↵</span>}
                    </button>
                  </div>
                );
              })}
            </div>
          </ScrollArea>
          <div className="flex items-center gap-3 border-t border-line px-4 py-2 text-[11px] text-ink3">
            <span>
              <span className="kbd text-[10px]">↑↓</span> move
            </span>
            <span>
              <span className="kbd text-[10px]">↵</span> open
            </span>
            <span className="ml-auto">Drop videos anywhere to start projects · {MOD}K</span>
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
  );
}
