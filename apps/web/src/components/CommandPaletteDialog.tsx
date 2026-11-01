import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFuzzy, Highlight, type Fuzzy, type FuseResultMatch } from "../lib/fuzzy";
import { useNavigate } from "react-router";
import {
  ChevronLeft,
  Download,
  Ban,
  ExternalLink,
  Film,
  FolderOpen,
  Images,
  Layers,
  Star,
  LifeBuoy,
  Link2,
  MoreHorizontal,
  Moon,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Settings,
  Sparkles,
  Trash2,
  Upload,
} from "lucide-react";
import { openReportHere } from "../lib/report";
import { useTRPC } from "../lib/trpc";
import { useSession } from "../lib/auth";
import { useTheme } from "../lib/theme";
import { setPendingBumperFiles, useUploads } from "../lib/uploads";
import { useMe } from "../lib/account";
import { toast } from "sonner";
import { extractUrls, isOnlyUrls, linkKey, youtubeId } from "../lib/links";
import { ago } from "../lib/time";
import { formatTag, searchable, SEARCH_KEYS } from "../lib/library";
import { ScrollArea } from "./scroll-area";
import { ConfirmDialog, Skeleton, SkeletonRegion, StatusText } from "./ui";
import { ForgetDecisionsOption } from "./ForgetDecisionsOption";
import { CHANGELOG_URL, DELETED_PATH, formatTime } from "@reelsaw/shared";
import { useDeletedToast } from "../lib/deletedToast";
import { useRestoreWindow } from "../lib/retention";
import { DeleteAssetDialog } from "./BumperField";

const MOD = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
/** Whitespace and newlines collapse to single spaces so a pasted list of links survives a one-line input. */
const oneLine = (s: string) => s.trim().split(/\s+/).join(" ");

/** What a pasted link looks like inside a stored source link: a YouTube id, else host and path. The server prefilters with it; linkKey decides. */
function linkNeedle(url: string): string {
  const yt = youtubeId(url);
  if (yt) return yt;
  try {
    const u = new URL(url.trim());
    return `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return url.trim();
  }
}

/** Fuse ranks and highlights the few rows the server returned; rows it does not match stay, after the ranked ones. */
function rankRows<T>(fz: Fuzzy<T>, rows: T[], q: string): Array<{ item: T; matches?: readonly FuseResultMatch[] }> {
  const ranked = fz.search(q);
  const seen = new Set(ranked.map((r) => r.item));
  return [...ranked.map((r) => ({ item: r.item, matches: r.matches })), ...rows.filter((r) => !seen.has(r)).map((item) => ({ item }))];
}

/** What the action list (→) is about. */
type Target = { kind: "project" | "clip" | "asset"; id: string } | { kind: "pick"; slot: "intro" | "outro"; id: string };

interface Item {
  key: string;
  group: string;
  label: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  thumb?: string | null | undefined;
  /** a 9:16 thumbnail (library items) rather than a 16:9 one */
  tall?: boolean;
  danger?: boolean | undefined;
  /** → / Tab / the ⋯ button open this item's action list */
  actions?: Target;
  run: () => void;
}

/** kind, length, size and badges of a library item on one line */
function assetHint(
  a: { kind: string; mime?: string | null; durationSec: number; width: number; height: number; usedBy: number; id: string },
  defaults?: { introAssetId?: string; outroAssetId?: string },
): string {
  const badges = [
    defaults?.introAssetId === a.id ? "default intro" : "",
    defaults?.outroAssetId === a.id ? "default outro" : "",
    a.usedBy ? `used by ${a.usedBy}` : "",
  ].filter(Boolean);
  return [formatTag(a.mime) ?? a.kind, `${a.durationSec.toFixed(a.durationSec % 1 ? 1 : 0)} s`, `${a.width}×${a.height}`, ...badges]
    .filter(Boolean)
    .join(" · ");
}

function download(href: string) {
  const a = Object.assign(document.createElement("a"), { href, download: "" });
  document.body.append(a);
  a.click();
  a.remove();
}

export function Palette({ open, onOpenChange, q, setQ }: { open: boolean; onOpenChange: (o: boolean) => void; q: string; setQ: (s: string) => void }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [, toggleTheme] = useTheme();
  const { startProjects, openWithFile } = useUploads();
  const fileRef = useRef<HTMLInputElement>(null);
  const bumperFileRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const retry = useMutation(trpc.projects.retry.mutationOptions());
  const refine = useMutation(trpc.projects.refine.mutationOptions());
  const del = useMutation(trpc.projects.delete.mutationOptions());
  const delClip = useMutation(trpc.clips.delete.mutationOptions());
  const notifyDeleted = useDeletedToast();
  const rerender = useMutation(trpc.clips.rerender.mutationOptions());
  const create = useMutation(trpc.projects.create.mutationOptions());
  const setBumpers = useMutation(trpc.projects.setBumpers.mutationOptions());
  const setDefault = useMutation(trpc.library.setDefault.mutationOptions());
  const removeAsset = useMutation(trpc.library.delete.mutationOptions());
  const assetWindow = useRestoreWindow("asset", open);
  const defaults = useMe().data?.projectDefaults;
  // seconds for an image picked in a Set intro / outro list; empty = the item's own length
  const [pickSec, setPickSec] = useState("");

  // the library, fetched only while the palette is open
  const libQ = useQuery({ ...trpc.library.list.queryOptions({ limit: 500 }), enabled: open, staleTime: 30_000 });
  const library = libQ.data?.items;
  const libFuse = useMemo(() => (library ? createFuzzy(library.map(searchable), SEARCH_KEYS) : null), [library]);
  const assetName = (id?: string | null) => (id ? (library?.find((a) => a.id === id)?.name ?? "deleted") : "none");

  // The list before typing is the 20 most recent projects; typing asks the server (debounced), which matches in SQL
  // and returns a handful of rows. Fuse only ranks and highlights those rows.
  const linkMode = isOnlyUrls(q);
  const urls = useMemo(() => (linkMode ? extractUrls(q) : []), [q, linkMode]);
  const [dq, setDq] = useState(q);
  useEffect(() => {
    if (!open) return;
    if (!q.trim() || isOnlyUrls(q)) return setDq(q);
    const t = window.setTimeout(() => setDq(q), 120);
    return () => window.clearTimeout(t);
  }, [q, open]);
  const searching = dq.trim() !== "";
  const recentQ = useQuery({ ...trpc.searchIndex.queryOptions(), enabled: open, staleTime: 30_000 });
  const searchQ = useQuery({
    ...trpc.search.queryOptions({ q: linkMode ? "" : dq.trim(), limit: 15, links: linkMode ? urls.map(linkNeedle) : undefined }),
    enabled: open && searching,
    placeholderData: keepPreviousData,
    staleTime: 15_000,
  });
  const countsQ = useQuery({ ...trpc.projects.counts.queryOptions(), enabled: open, staleTime: 30_000 });
  const counts = countsQ.data;
  type Proj = NonNullable<typeof recentQ.data>["projects"][number];
  type ClipRow = NonNullable<typeof searchQ.data>["clips"][number];
  // a pasted link is only answered by results for that link, never by the previous query's
  const staleLink = linkMode && (searchQ.isPlaceholderData || !searchQ.data);
  const index = searching
    ? staleLink
      ? undefined
      : searchQ.data
    : recentQ.data
      ? { projects: recentQ.data.projects, clips: [] as ClipRow[], truncated: false }
      : undefined;
  const loadingIndex = searching ? !searchQ.data || staleLink : !recentQ.data;
  // everything the palette has shown, so an item's action list still works after the query changes
  const known = useRef({ projects: new Map<string, Proj>(), clips: new Map<string, ClipRow>() });
  for (const p of index?.projects ?? []) known.current.projects.set(p.id, p);
  for (const c of index?.clips ?? []) known.current.clips.set(c.id, c);
  const fuse = useMemo(() => {
    if (!index) return null;
    return {
      // loose: the server already decided what matches, Fuse only orders and highlights what it recognises
      projects: createFuzzy(index.projects, [{ name: "title", weight: 1 }], { threshold: 0.6 }),
      clips: createFuzzy(
        index.clips,
        [
          { name: "title", weight: 3 },
          { name: "hook", weight: 1.5 },
          { name: "projectTitle", weight: 1 },
          { name: "caption", weight: 0.6 },
        ],
        { threshold: 0.6 },
      ),
    };
  }, [index]);
  // per-project clip facts come with each project row
  const stats = {
    get: (id: string) => {
      const p = known.current.projects.get(id);
      return p ? { clips: p.clipCount, done: p.clipsDone, failed: p.failedClipIds.map((cid) => ({ id: cid })) } : undefined;
    },
  };
  const failedClipCount = counts?.failedClips ?? 0;
  const failedProjectCount = counts?.failedProjects ?? 0;

  const [cursor, setCursor] = useState(0);
  const [target, setTarget] = useState<Target | null>(null);
  const [confirm, setConfirm] = useState<null | { kind: "refine" | "delete" | "clip" | "asset"; id: string; title: string }>(null);
  const [forgetDecisions, setForgetDecisions] = useState(false);
  // projects and clips share one window (DELETED_RETENTION_DAYS)
  const keepWindow = useRestoreWindow("project", confirm?.kind === "delete" || confirm?.kind === "clip");
  const savedQ = useRef("");
  const go = (fn: () => void) => () => {
    onOpenChange(false);
    fn();
  };

  const refresh = (_projectId?: string) => {
    void qc.invalidateQueries({ queryKey: trpc.searchIndex.queryKey() });
    void qc.invalidateQueries({ queryKey: trpc.search.pathKey() });
    // the Projects page (list and header counts), the project pages and the failed-work counts all live under projects
    void qc.invalidateQueries({ queryKey: trpc.projects.pathKey() });
  };
  /** Runs one mutation after the palette has closed; says in plain words how it went. */
  const act = (done: string, failed: string, fn: () => Promise<unknown>, projectId?: string) =>
    go(() => {
      fn().then(
        () => (refresh(projectId), toast(done)),
        (err: Error) => toast.error(`${failed}: ${err.message.slice(0, 120)}`),
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
        const tid = toast.loading(`Starting project 1 of ${urls.length}…`);
        for (const [i, sourceUrl] of urls.entries()) {
          toast.loading(`Starting project ${i + 1} of ${urls.length}…`, { id: tid });
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
        (ok < urls.length ? toast.error : toast.success)(parts.join(" · "), { id: tid });
      })();
    });

  // ----- row content -----
  const projectHint = (p: Proj): ReactNode => {
    const n = p.clipCount;
    return (
      <>
        <StatusText status={p.status} />
        {p.durationSec ? ` · ${formatTime(p.durationSec)}` : ""} · {plural(n, "clip")} · {ago(p.updatedAt)}
      </>
    );
  };
  const clipHint = (c: ClipRow, snippet?: ReactNode): ReactNode => (
    <>
      <StatusText status={c.status} /> · <span className="font-mono">{formatTime(Math.max(0, c.endSec - c.startSec))}</span> · {snippet ?? c.projectTitle} ·{" "}
      <span className="font-mono">@{formatTime(c.startSec)}</span>
    </>
  );
  const projectItem = (p: Proj, group: string, label: ReactNode = p.title): Item => ({
    key: `p-${p.id}`,
    group,
    thumb: p.thumbnailUrl,
    label,
    hint: projectHint(p),
    actions: { kind: "project", id: p.id },
    run: go(() => nav(`/p/${p.id}`)),
  });

  const items: Item[] = useMemo(() => {
    const out: Item[] = [];
    const ql = q.trim();
    const d = index;

    // ----- an item's own action list -----
    if (target) {
      const acts: Item[] = [];
      if (target.kind === "pick") {
        const { slot, id: projectId } = target;
        const label = slot === "intro" ? "Intro" : "Outro";
        const n = stats.get(projectId)?.done ?? 0;
        const defaultId = defaults?.[slot === "intro" ? "introAssetId" : "outroAssetId"];
        const choose = (choice: string, name: string) =>
          go(() => {
            const shownId = choice === "default" ? defaultId : choice;
            const isImage = !!shownId && library?.find((a) => a.id === shownId)?.kind === "image";
            const sec = Number(pickSec);
            const secs = isImage && pickSec !== "" && Number.isFinite(sec) ? { [`${slot}Sec`]: Math.min(10, Math.max(1, sec)) } : {};
            setBumpers.mutateAsync({ id: projectId, [slot]: choice, ...secs, rerender: false }).then(
              () => (refresh(projectId), toast(`${label}: ${name}. Saved; re-render ${plural(n, "clip")} to apply`)),
              (err: Error) => toast.error(`Couldn’t set the ${slot}: ${err.message.slice(0, 120)}`),
            );
          });
        const P = (key: string, text: string, icon: ReactNode, run: () => void, hint?: string, thumb?: string): Item => ({
          key: `tp-${key}`,
          group: label,
          label: text,
          hint,
          icon,
          thumb,
          tall: !!thumb,
          run,
        });
        acts.push(
          P("default", `Project default (${assetName(defaultId)})`, <Star className="h-4 w-4" />, choose("default", "default"), "What Settings say now"),
        );
        acts.push(P("none", "None", <Ban className="h-4 w-4" />, choose("none", "none"), "No " + slot + " on this project"));
        for (const a of library ?? []) acts.push(P(a.id, a.name, <Images className="h-4 w-4" />, choose(a.id, a.name), assetHint(a, defaults), a.thumbnailUrl));
        return ql ? createFuzzy(acts, ["label", "hint"], { threshold: 0.4, minMatchCharLength: 1 }).filter(ql) : acts;
      }
      if (target.kind === "asset") {
        const a = library?.find((x) => x.id === target.id);
        if (!a) return out;
        const A = (key: string, label: string, icon: ReactNode, run: () => void, hint?: string, danger?: boolean): Item => ({
          key: `ta-${key}`,
          group: "Actions",
          label,
          icon,
          hint,
          danger,
          run,
        });
        for (const slot of ["intro", "outro"] as const) {
          const current = defaults?.[slot === "intro" ? "introAssetId" : "outroAssetId"];
          acts.push(
            A(
              slot,
              current === a.id ? `Stop using as ${slot} default` : `Use as ${slot} default`,
              <Images className="h-4 w-4" />,
              act(
                current === a.id ? `No default ${slot}` : `New projects start with this ${slot}`,
                "Couldn’t save",
                () =>
                  setDefault.mutateAsync({ slot, assetId: current === a.id ? null : a.id }).then(() => qc.invalidateQueries({ queryKey: trpc.me.pathKey() })),
                undefined,
              ),
              "For new projects",
            ),
          );
        }
        acts.unshift(
          A(
            "open",
            "Open in library",
            <ExternalLink className="h-4 w-4" />,
            go(() => nav(`/library#asset=${a.id}`)),
          ),
        );
        acts.push(
          A(
            "delete",
            "Delete…",
            <Trash2 className="h-4 w-4" />,
            go(() => setConfirm({ kind: "asset", id: a.id, title: a.name })),
            a.usedBy ? `Used by ${plural(a.usedBy, "project")}; they keep rendering with it` : "You can restore it from Deleted",
            true,
          ),
        );
        return ql ? createFuzzy(acts, ["label", "hint"], { threshold: 0.4, minMatchCharLength: 1 }).filter(ql) : acts;
      }
      if (target.kind === "project") {
        const p = known.current.projects.get(target.id);
        if (!p) return out;
        const s = stats.get(p.id);
        const A = (key: string, label: string, icon: ReactNode, run: () => void, hint?: string, danger?: boolean): Item => ({
          key: `ta-${key}`,
          group: "Actions",
          label,
          icon,
          hint,
          danger,
          run,
        });
        acts.push(
          A(
            "open",
            "Open",
            <ExternalLink className="h-4 w-4" />,
            go(() => nav(`/p/${p.id}`)),
          ),
        );
        if (s?.done)
          acts.push(
            A(
              "export",
              "Export zip",
              <Download className="h-4 w-4" />,
              go(() => download(`/api/projects/${p.id}/export.zip`)),
              `${plural(s.done, "rendered clip")} with paste-ready metadata`,
            ),
          );
        if (p.status === "failed" || p.status === "done")
          acts.push(
            A(
              "resume",
              "Resume pipeline",
              <Play className="h-4 w-4" />,
              act("Pipeline resumed", "Couldn’t resume", () => retry.mutateAsync({ id: p.id }), p.id),
              "From the last stage that didn’t finish",
            ),
          );
        if (s?.failed.length)
          acts.push(
            A(
              "retry-clips",
              `Retry failed clips (${s.failed.length})`,
              <RotateCcw className="h-4 w-4" />,
              act(
                `Retrying ${plural(s.failed.length, "failed clip")}`,
                "Couldn’t retry",
                () => Promise.all(s.failed.map((c) => rerender.mutateAsync({ id: c.id }))),
                p.id,
              ),
            ),
          );
        acts.push(
          A(
            "intro",
            "Set intro…",
            <Images className="h-4 w-4" />,
            () => (setQ(""), setTarget({ kind: "pick", slot: "intro", id: p.id })),
            "Default, none or a library item",
          ),
        );
        acts.push(
          A(
            "outro",
            "Set outro…",
            <Images className="h-4 w-4" />,
            () => (setQ(""), setTarget({ kind: "pick", slot: "outro", id: p.id })),
            "Default, none or a library item",
          ),
        );
        if (p.status === "done" || p.status === "failed")
          acts.push(
            A(
              "refine",
              "Re-run refine…",
              <Sparkles className="h-4 w-4" />,
              go(() => setConfirm({ kind: "refine", id: p.id, title: p.title })),
              "Names, disfluencies, scene changes",
            ),
          );
        acts.push(
          A(
            "delete",
            "Delete project…",
            <Trash2 className="h-4 w-4" />,
            go(() => setConfirm({ kind: "delete", id: p.id, title: p.title })),
            "Hides the source, transcript and every clip until you restore it",
            true,
          ),
        );
      } else {
        const c = known.current.clips.get(target.id);
        if (!c) return out;
        const A = (key: string, label: string, icon: ReactNode, run: () => void, hint?: string, danger?: boolean): Item => ({
          key: `ta-${key}`,
          group: "Actions",
          label,
          icon,
          hint,
          danger,
          run,
        });
        acts.push(
          A(
            "open",
            "Open in project",
            <ExternalLink className="h-4 w-4" />,
            go(() => nav(`/p/${c.projectId}#clip=${c.id}`)),
          ),
        );
        acts.push(
          A(
            "edit",
            "Edit clip",
            <Pencil className="h-4 w-4" />,
            go(() => nav(`/p/${c.projectId}/clips/${c.id}`)),
          ),
        );
        acts.push(
          A(
            "rerender",
            "Re-render",
            <RefreshCw className="h-4 w-4" />,
            act("Re-rendering the clip", "Couldn’t re-render", () => rerender.mutateAsync({ id: c.id }), c.projectId),
          ),
        );
        if (c.videoUrl && c.status === "done")
          acts.push(
            A(
              "download",
              "Download clip",
              <Download className="h-4 w-4" />,
              go(() => download(`${c.videoUrl}?download`)),
              "The rendered mp4",
            ),
          );
        acts.push(
          A(
            "delete",
            "Delete clip…",
            <Trash2 className="h-4 w-4" />,
            go(() => setConfirm({ kind: "clip", id: c.id, title: c.title || "Untitled clip" })),
            "Hidden until you restore it from Deleted",
            true,
          ),
        );
      }
      return ql ? createFuzzy(acts, ["label", "hint"], { threshold: 0.4, minMatchCharLength: 1 }).filter(ql) : acts;
    }

    // ----- a link, or a list of links: act on what already exists, otherwise start -----
    if (linkMode) {
      const have = new Map((d?.projects ?? []).filter((p) => p.sourceUrl).map((p) => [linkKey(p.sourceUrl!), p]));
      if (urls.length === 1) {
        const existing = have.get(linkKey(urls[0]!));
        if (existing) out.push(projectItem(existing, "Already in your projects", `Open ${existing.title}`));
        out.push({
          key: "new-url",
          group: "Start",
          icon: <Link2 className="h-4 w-4" />,
          label: "New project from this link",
          hint: <span className="truncate font-mono">{urls[0]}</span>,
          run: go(() => nav(`/new?url=${encodeURIComponent(urls[0]!)}`)),
        });
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
      {
        key: "a-upload",
        group: "Actions",
        icon: <Upload className="h-4 w-4" />,
        label: "Upload videos…",
        hint: "several start a project each",
        run: () => fileRef.current?.click(),
      },
      { key: "a-projects", group: "Actions", icon: <FolderOpen className="h-4 w-4" />, label: "Go to projects", run: go(() => nav("/")) },
      {
        key: "a-library",
        group: "Actions",
        icon: <Images className="h-4 w-4" />,
        label: "Go to library",
        hint: "intros, outros, images, audio",
        run: go(() => nav("/library")),
      },
      {
        key: "a-templates",
        group: "Actions",
        icon: <Layers className="h-4 w-4" />,
        label: "Go to templates",
        hint: "layer templates for any clip length",
        run: go(() => nav("/templates")),
      },
      {
        key: "a-upload-bumper",
        group: "Actions",
        icon: <Upload className="h-4 w-4" />,
        label: "Add to library…",
        hint: "video, image or audio",
        run: () => bumperFileRef.current?.click(),
      },
      { key: "a-settings", group: "Actions", icon: <Settings className="h-4 w-4" />, label: "Go to settings", run: go(() => nav("/settings")) },
      {
        key: "a-deleted",
        group: "Actions",
        icon: <Trash2 className="h-4 w-4" />,
        label: "Go to deleted",
        hint: "restore or delete forever",
        run: go(() => nav(DELETED_PATH)),
      },
      {
        key: "a-releases",
        group: "Actions",
        icon: <Sparkles className="h-4 w-4" />,
        label: "What's new",
        hint: "reelsaw.com/releases",
        run: go(() => window.open(CHANGELOG_URL, "_blank", "noopener,noreferrer")),
      },
      { key: "a-theme", group: "Actions", icon: <Moon className="h-4 w-4" />, label: "Toggle light / dark theme", run: go(toggleTheme) },
      {
        key: "a-report",
        group: "Actions",
        icon: <LifeBuoy className="h-4 w-4" />,
        label: "Report an issue…",
        hint: "bug, feedback · !",
        run: go(openReportHere),
      },
    ];
    // global commands only appear when there is something for them to do
    if (failedClipCount)
      actions.unshift({
        key: "a-retry-clips",
        group: "Actions",
        icon: <RotateCcw className="h-4 w-4" />,
        label: `Retry all failed clips (${failedClipCount})`,
        hint: `across ${plural(counts?.failedClipProjects ?? 0, "project")}`,
        run: go(() => {
          void each(counts?.failedClipIds ?? [], (id) => rerender.mutateAsync({ id })).then((r) => {
            refresh();
            toast(
              r.failed
                ? `Retrying ${plural(r.ok, "clip")} · ${r.failed} couldn’t be queued${r.firstError ? ` (${r.firstError.slice(0, 80)})` : ""}`
                : `Retrying ${plural(r.ok, "failed clip")}`,
            );
          });
        }),
      });
    if (failedProjectCount)
      actions.unshift({
        key: "a-resume-projects",
        group: "Actions",
        icon: <Play className="h-4 w-4" />,
        label: `Resume failed projects (${failedProjectCount})`,
        hint: "each from the last stage that didn’t finish",
        run: go(() => {
          void each(counts?.failedProjectIds ?? [], (id) => retry.mutateAsync({ id })).then((r) => {
            refresh();
            toast(
              r.failed
                ? `Resumed ${plural(r.ok, "project")} · ${r.failed} couldn’t be resumed${r.firstError ? ` (${r.firstError.slice(0, 80)})` : ""}`
                : `Resumed ${plural(r.ok, "failed project")}`,
            );
          });
        }),
      });
    if (!ql) {
      for (const p of (d?.projects ?? []).slice(0, 6)) out.push(projectItem(p, "Recent projects"));
      return [...out, ...actions];
    }
    const actionFuse = createFuzzy(actions, ["label", "hint"], { threshold: 0.4, minMatchCharLength: 1 });
    for (const r of actionFuse.search(ql, 3)) out.push({ ...r.item, label: <Highlight text={String(r.item.label)} matches={r.matches} k="label" /> });
    if (libFuse) {
      for (const r of libFuse.search(ql).slice(0, 5)) {
        const a = r.item;
        out.push({
          key: `l-${a.id}`,
          group: "Library",
          icon: <Images className="h-4 w-4" />,
          thumb: a.thumbnailUrl,
          tall: true,
          label: <Highlight text={a.name} matches={r.matches} k="name" />,
          hint: assetHint(a, defaults),
          actions: { kind: "asset", id: a.id },
          run: go(() => nav(`/library#asset=${a.id}`)),
        });
      }
    }
    if (fuse) {
      for (const r of rankRows(fuse.projects, index!.projects, ql).slice(0, 8))
        out.push(projectItem(r.item, "Projects", <Highlight text={r.item.title} matches={r.matches} k="title" />));
      for (const r of rankRows(fuse.clips, index!.clips, ql)) {
        const c = r.item;
        const via = r.matches?.find((m) => m.key !== "title");
        out.push({
          key: `c-${c.id}`,
          group: "Clips",
          thumb: c.thumbnailUrl,
          icon: <Film className="h-4 w-4" />,
          label: <Highlight text={c.title || "Untitled clip"} matches={r.matches} k="title" />,
          // show where the match was when it wasn't the title: the hook or caption snippet
          hint: clipHint(
            c,
            via && (via.key === "hook" || via.key === "caption") && typeof via.value === "string" ? (
              <Highlight text={via.value} matches={[via]} k={via.key} />
            ) : undefined,
          ),
          actions: { kind: "clip", id: c.id },
          run: go(() => nav(`/p/${c.projectId}#clip=${c.id}`)),
        });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, linkMode, urls, target, index, fuse, counts, library, libFuse, defaults, pickSec, recentQ.data, searchQ.data]);

  useEffect(() => setCursor(0), [q, target]);
  useEffect(() => setPickSec(""), [target]);
  useEffect(() => {
    if (!open) setTarget(null);
  }, [open]);
  // the item an open action list belongs to was deleted: back to the list
  useEffect(() => {
    if (!target) return;
    if (target.kind === "asset" && library && !library.some((a) => a.id === target.id)) setTarget(null);
  }, [target, library]);
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
  const crumb = !target
    ? null
    : target.kind === "asset"
      ? library?.find((a) => a.id === target.id)?.name
      : target.kind === "pick"
        ? `${known.current.projects.get(target.id)?.title ?? ""} · ${target.slot === "intro" ? "Intro" : "Outro"}`
        : target.kind === "project"
          ? known.current.projects.get(target.id)?.title
          : known.current.clips.get(target.id)?.title || "Untitled clip";

  let lastGroup = "";
  return (
    <>
      <Dialog.Root open={open} onOpenChange={onOpenChange}>
        <Dialog.Portal>
          {/* z-[85]/[86] sit above the confirm dialogs (z-[70]/[71]); the palette closes before a confirm opens */}
          <Dialog.Overlay className="fixed inset-0 z-[85] bg-black/40" />
          <Dialog.Content
            className="fixed left-1/2 top-[12dvh] z-[86] flex w-[min(640px,calc(100vw-24px))] -translate-x-1/2 flex-col overflow-hidden rounded-[18px] border border-line bg-panel text-ink shadow-pop outline-none"
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
                <button
                  type="button"
                  onClick={back}
                  className="flex h-7 max-w-[45%] shrink-0 items-center gap-1 rounded-[8px] bg-sunk pl-1.5 pr-2.5 text-xs font-semibold text-ink2 hover:text-ink"
                  aria-label="Back to results"
                  title="Back (←)"
                >
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
                placeholder={
                  target
                    ? target.kind === "pick"
                      ? "Filter your library…"
                      : "Filter actions…"
                    : "Search projects, clips and your library, or paste video links…"
                }
                className="h-[52px] min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-ink3 focus-visible:outline-none"
                aria-label={target ? "Filter actions" : "Search"}
              />
              <span className="kbd">esc</span>
            </div>
            <ScrollArea className="max-h-[min(460px,60dvh)]">
              <div ref={listRef} className="flex flex-col p-1.5">
                {items.length === 0 && (target?.kind === "pick" ? libQ.isLoading : !target && loadingIndex) && (
                  <SkeletonRegion label="Loading…" className="flex flex-col">
                    {[0, 1, 2, 3, 4].map((i) => (
                      <div key={i} className="flex items-center gap-3 px-2.5 py-2">
                        <Skeleton className="h-8 w-8 shrink-0 rounded-[8px]" />
                        <span className="min-w-0 flex-1">
                          <span className="flex h-5 items-center">
                            <Skeleton className={`h-3 ${["w-2/5", "w-1/2", "w-1/3", "w-3/5", "w-2/5"][i]}`} />
                          </span>
                          <span className="flex h-4 items-center">
                            <Skeleton className={`h-2.5 ${["w-1/4", "w-1/3", "w-1/5", "w-2/5", "w-1/4"][i]}`} />
                          </span>
                        </span>
                      </div>
                    ))}
                  </SkeletonRegion>
                )}
                {items.length === 0 && !(target?.kind === "pick" ? libQ.isLoading : !target && loadingIndex) && (
                  <div className="px-3 py-8 text-center text-sm text-ink3">No matches</div>
                )}
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
                            <img
                              src={it.thumb}
                              alt=""
                              referrerPolicy="no-referrer"
                              className={`shrink-0 rounded-[6px] object-cover ${it.group === "Clips" || it.tall ? "h-9 w-[20px]" : "h-8 w-[56px]"}`}
                            />
                          ) : (
                            <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-[8px] bg-sunk ${it.danger ? "text-err" : "text-ink2"}`}>
                              {it.icon ?? <FolderOpen className="h-4 w-4" />}
                            </span>
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
                {!target && !linkMode && searching && searchQ.data?.truncated && items.length > 0 && (
                  <div className="px-3 pb-1 pt-2 text-xs text-ink3">More match than shown. Keep typing to narrow it down.</div>
                )}
              </div>
            </ScrollArea>
            {target?.kind === "pick" && (
              <label className="flex items-center gap-2 border-t border-line px-4 py-2 text-xs text-ink2">
                Seconds, if you pick an image
                <input
                  className="input h-7 w-16 px-2 py-0 text-xs"
                  type="number"
                  min={1}
                  max={10}
                  step={0.5}
                  value={pickSec}
                  placeholder="its own"
                  onChange={(e) => setPickSec(e.target.value)}
                  aria-label="Seconds an image is shown"
                />
                s
              </label>
            )}
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
              ref={bumperFileRef}
              type="file"
              multiple
              accept=".mp4,.mov,.webm,.png,.jpg,.jpeg,video/mp4,video/quicktime,video/webm,image/png,image/jpeg"
              className="hidden"
              aria-label="Choose intro or outro files"
              onChange={(e) => {
                const files = [...(e.target.files ?? [])];
                e.target.value = "";
                if (!files.length) return;
                onOpenChange(false);
                setPendingBumperFiles(files);
                nav("/library");
              }}
            />
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
            (err: Error) => toast.error(`Couldn’t re-run refine: ${err.message.slice(0, 120)}`),
          );
        }}
      />
      <DeleteAssetDialog
        asset={
          confirm?.kind === "asset"
            ? (library?.find((x) => x.id === confirm.id) ?? { id: confirm.id, name: confirm.title, usedBy: 0, usedByTemplates: 0 })
            : null
        }
        onClose={() => setConfirm(null)}
        onConfirm={() => {
          const c = confirm!;
          const a = library?.find((x) => x.id === c.id);
          removeAsset.mutateAsync({ id: c.id }).then(
            () => {
              refresh();
              void qc.invalidateQueries({ queryKey: trpc.library.pathKey() });
              notifyDeleted({
                items: [{ kind: "asset", id: c.id, title: c.title }],
                restorable: assetWindow.restorable,
                canPurge: !a?.usedBy && !a?.usedByClips && !a?.usedByTemplates,
              });
            },
            (err: Error) => toast.error(`Couldn’t delete: ${err.message.slice(0, 120)}`),
          );
        }}
      />
      <ConfirmDialog
        open={confirm?.kind === "delete"}
        onOpenChange={(o) => {
          if (!o) setConfirm(null);
          setForgetDecisions(false);
        }}
        title="Delete this project?"
        body={`“${confirm?.title ?? ""}”: the project, its transcript and every clip are hidden. Work in progress stops. ${keepWindow.hint()} Storage still counts until you delete it forever.`}
        confirm="Delete project"
        danger
        onConfirm={() => {
          const c = confirm!;
          del.mutateAsync({ id: c.id, forgetDecisions }).then(
            (r) => {
              refresh();
              notifyDeleted({
                items: [{ kind: "project", id: c.id, title: c.title }],
                restorable: r.restorable,
                storedBytes: r.storedBytes,
              });
            },
            (err: Error) => toast.error(`Couldn’t delete: ${err.message.slice(0, 120)}`),
          );
        }}
      >
        <ForgetDecisionsOption checked={forgetDecisions} onChange={setForgetDecisions} later />
      </ConfirmDialog>
      <ConfirmDialog
        open={confirm?.kind === "clip"}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Delete this clip?"
        body={`“${confirm?.title ?? ""}” is hidden from the project. ${keepWindow.hint()} Storage still counts until you delete it forever.`}
        confirm="Delete clip"
        danger
        onConfirm={() => {
          const c = confirm!;
          delClip.mutateAsync({ id: c.id }).then(
            (r) => {
              refresh();
              notifyDeleted({
                items: [{ kind: "clip", id: c.id, title: c.title }],
                restorable: r.restorable,
                storedBytes: r.storedBytes,
              });
            },
            (err: Error) => toast.error(`Couldn’t delete: ${err.message.slice(0, 120)}`),
          );
        }}
      />
    </>
  );
}
