import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { peekPendingFile, takePendingFile, uploadFile as postUpload, isVideo, clearPendingFile, uploadSizeProblem, useLeaveWarning } from "../lib/uploads";
import { Ban, ChevronRight, Star } from "lucide-react";
import { SlotRow, useBumperLibrary } from "../components/BumperField";
import type { FixedOption } from "../components/BumperCombobox";
import { ScrollArea } from "../components/scroll-area";
import { ProgressBar, Segmented, Skeleton } from "../components/ui";
import { useTRPC, useTRPCClient } from "../lib/trpc";
import { track } from "../lib/telemetry";
import { useMe, useSystemStatus } from "../lib/account";
import { toast } from "sonner";
import { defaultProjectSettings, projectSettingsSchema, userProjectDefaultsSchema, styleSchema, type ProjectSettings, type Style } from "@reelsaw/shared";
import { VerticalPreview, type PreviewLayout, type PreviewWord } from "../components/VerticalPreview";
import { RefineToggles } from "../components/RefineToggles";
import { youtubeId } from "../lib/links";
import { QuotaNotice, quotaFromError } from "../components/QuotaNotice";

const LENGTHS = [
  { id: "short", label: "< 30s", min: 10, max: 30 },
  { id: "medium", label: "20–60s", min: 20, max: 60 },
  { id: "long", label: "45–90s", min: 45, max: 90 },
  { id: "xl", label: "1–3 min", min: 60, max: 180 },
] as const;

const SAMPLE = "This is how your captions will look on every clip you make".split(" ");
const SAMPLE_WORDS: PreviewWord[] = SAMPLE.map((text, i) => ({ text, start: i * 0.38, end: i * 0.38 + 0.34 }));
const SAMPLE_LOOP = SAMPLE_WORDS.at(-1)!.end + 0.6;

function useDebounced<T>(v: T, ms: number) {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

export function NewProjectPage() {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const nav = useNavigate();
  const qc = useQueryClient();
  const status = useSystemStatus();
  const me = useMe();
  const uploadCtrl = useRef<AbortController | null>(null);
  const create = useMutation({
    mutationFn: async (input: { title?: string | undefined; sourceUrl?: string | undefined; file?: File; settings: ProjectSettings }) => {
      uploadCtrl.current = new AbortController();
      const uploadId = input.file ? await postUpload(input.file, setUploadPct, uploadCtrl.current.signal) : undefined;
      return client.projects.create.mutate({ title: input.title, sourceUrl: input.sourceUrl, uploadId, settings: input.settings });
    },
    onSettled: () => setUploadPct(null),
  });
  const saveDefaults = useMutation({ ...trpc.me.updateProjectDefaults.mutationOptions(), onSuccess: () => void qc.invalidateQueries({ queryKey: trpc.me.pathKey() }) });

  // prefilled from ⌘K (?url=) or a single video dropped anywhere in the app
  const [search] = useSearchParams();
  const loc = useLocation();
  const [file, setFileRaw] = useState<File | null>(() => peekPendingFile());
  // a file over the server's limit is refused up front, not after minutes of uploading
  const maxMb = status.data?.maxUploadMb;
  const setFile = (f: File | null) => {
    const problem = f && uploadSizeProblem(f, maxMb);
    if (problem) return void toast.error(problem);
    setFileRaw(f);
  };
  // a file handed over from the dropzone that this page never took must not stay behind
  useEffect(() => clearPendingFile, []);
  const [mode, setMode] = useState<"url" | "upload">(() => (file ? "upload" : "url"));
  const [url, setUrl] = useState(() => search.get("url") ?? "");
  useEffect(() => {
    const f = takePendingFile();
    if (f) {
      setFileRaw(f);
      setMode("upload");
    }
    const u = search.get("url");
    if (u) {
      setUrl(u);
      setMode("url");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc.key]);
  const [title, setTitle] = useState("");
  const [s, setS] = useState<ProjectSettings>(defaultProjectSettings);
  // the user's saved defaults fill the form once, before they touch it
  const [prefilledFor, setPrefilledFor] = useState<string | null>(null);
  useEffect(() => {
    if (me.data && prefilledFor !== me.data.id) {
      // intro/outro are chosen in their own section: "default" there means the keys stay absent
      const { introAssetId: _i, outroAssetId: _o, ...mine } = me.data.projectDefaults;
      setS(projectSettingsSchema.parse({ ...defaultProjectSettings, ...mine }));
      setPrefilledFor(me.data.id);
    }
  }, [me.data, prefilledFor]);
  // intro / outro: "default" (the user's own, snapshotted by the server), "none", or a library asset id
  const library = useBumperLibrary();
  const [bump, setBump] = useState<{ intro: string; outro: string; introSec?: number; outroSec?: number }>(() => ({ intro: search.get("intro") || "default", outro: search.get("outro") || "default" }));
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  useLeaveWarning(uploadPct !== null);
  const [previewAs, setPreviewAs] = useState<PreviewLayout>("face");
  const [safe, setSafe] = useState(true);
  const [more, setMore] = useState(false);

  const style: Style = useMemo(() => styleSchema.parse(s), [s]);
  const patch = (p: Partial<ProjectSettings>) => setS((prev) => ({ ...prev, ...p }));

  // preview source: YouTube max-res thumbnail, oEmbed thumbnail, or a frame of the picked file
  const debouncedUrl = useDebounced(url, 500);
  const ytId = youtubeId(debouncedUrl);
  const validUrl = /^https?:\/\/\S+\.\S+/.test(debouncedUrl);
  const peek = useQuery({ ...trpc.projects.peek.queryOptions({ url: debouncedUrl }), enabled: mode === "url" && validUrl && !ytId, staleTime: 600_000 });
  const [imgEl, setImgEl] = useState<HTMLImageElement | null>(null);
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const [srcDims, setSrcDims] = useState({ w: 1920, h: 1080 });

  useEffect(() => {
    setImgEl(null);
    if (mode !== "url") return;
    const candidates = ytId ? [`https://i.ytimg.com/vi/${ytId}/maxresdefault.jpg`, `https://i.ytimg.com/vi/${ytId}/hqdefault.jpg`] : peek.data?.thumbnail ? [peek.data.thumbnail] : [];
    if (!candidates.length) return;
    let i = 0;
    const img = new Image();
    img.referrerPolicy = "no-referrer";
    img.onload = () => {
      // YouTube serves a 120×90 grey placeholder when maxres does not exist
      if (img.naturalWidth <= 120 && i + 1 < candidates.length) {
        img.src = candidates[++i]!;
        return;
      }
      setSrcDims({ w: img.naturalWidth, h: img.naturalHeight });
      setImgEl(img);
    };
    img.onerror = () => {
      if (i + 1 < candidates.length) img.src = candidates[++i]!;
    };
    img.src = candidates[0]!;
  }, [mode, ytId, peek.data?.thumbnail]);

  const objectUrl = useMemo(() => (mode === "upload" && file ? URL.createObjectURL(file) : null), [mode, file]);
  useEffect(() => () => void (objectUrl && URL.revokeObjectURL(objectUrl)), [objectUrl]);
  const hiddenVideo = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = hiddenVideo.current;
    if (!v || !objectUrl) return setVideoEl(null);
    const onMeta = () => {
      v.currentTime = Math.min(30, (v.duration || 10) * 0.2);
      setSrcDims({ w: v.videoWidth, h: v.videoHeight });
    };
    const onSeeked = () => setVideoEl(v);
    v.addEventListener("loadedmetadata", onMeta);
    v.addEventListener("seeked", onSeeked);
    return () => {
      v.removeEventListener("loadedmetadata", onMeta);
      v.removeEventListener("seeked", onSeeked);
    };
  }, [objectUrl]);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (mode === "upload" && !file) return;
    const tooBig = mode === "upload" && file ? uploadSizeProblem(file, maxMb) : null;
    if (tooBig) return void toast.error(tooBig);
    create.mutate(
      { title: title || undefined, sourceUrl: mode === "url" ? url : undefined, ...(mode === "upload" && file ? { file } : {}), settings: { ...s, ...bumperSettings } },
      {
        onSuccess: (p) => {
          track("project_create_submitted", { source: mode, projectId: p.id });
          nav(`/p/${p.id}`);
        },
      },
    );
  }

  // only what differs from the user's default travels; "None" is an explicit null
  const libAssets = (library.data?.assets ?? []).filter((a) => a.kind !== "audio");
  const known = (c: string) => c === "default" || c === "none" || libAssets.some((a) => a.id === c);
  const chosen = { intro: known(bump.intro) ? bump.intro : "default", outro: known(bump.outro) ? bump.outro : "default" };
  const bumperSettings: Partial<ProjectSettings> = {};
  for (const slot of ["intro", "outro"] as const) {
    const c = chosen[slot];
    if (c === "default") continue;
    bumperSettings[`${slot}AssetId`] = c === "none" ? null : c;
    const sec = bump[`${slot}Sec`];
    if (c !== "none" && sec && libAssets.find((a) => a.id === c)?.kind === "image") bumperSettings[`${slot}Sec`] = Math.min(10, Math.max(1, sec));
  }
  const defaultName = (id: string | undefined) => (id ? ([...libAssets, ...(library.data?.deleted ?? [])].find((a) => a.id === id)?.name ?? "deleted") : "none");
  const fixed = (id: string | undefined): FixedOption[] => [
    { value: "default", label: `Your default (${defaultName(id)})`, hint: "What Settings say now", icon: <Star className="h-4 w-4" /> },
    { value: "none", label: "None", hint: "Nothing here", icon: <Ban className="h-4 w-4" /> },
  ];

  const busy = create.isPending;
  const lengthId = LENGTHS.find((l) => l.min === s.minClipSeconds && l.max === s.maxClipSeconds)?.id ?? "custom";
  const source = mode === "upload" ? videoEl : imgEl;

  const sec = "flex flex-col gap-3 rounded-[16px] border border-line bg-panel p-5";
  const h2 = "text-[15px] font-bold";
  const lenLabel = lengthId === "custom" ? `${s.minClipSeconds}–${s.maxClipSeconds}s` : LENGTHS.find((l) => l.id === lengthId)!.label;
  const look = { karaoke: "Highlight", box: "Boxed", plain: "Outlined", none: "No" }[style.captions];
  const summary = `${s.maxClips ? `At most ${s.maxClips} clips` : "Every strong moment"} · ${lenLabel} · ${look} captions${s.focus ? ` · about “${s.focus}”` : ""}`;
  const canStart = mode === "url" ? /^https?:\/\/\S+\.\S+/.test(url) : !!file;
  const chip = (on: boolean) => `rounded-full border px-3.5 py-1.5 text-[13px] font-semibold ${on ? "border-ink bg-ink text-bg" : "border-line bg-panel text-ink2 hover:text-ink"}`;

  return (
    <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <main className="mx-auto grid max-w-[1120px] gap-6 px-4 py-7 sm:px-6 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="flex min-w-0 flex-col gap-4">
            <div>
              <div className="text-xs text-ink3">
                <Link to="/" className="text-ink3 no-underline hover:text-ink">
                  Projects
                </Link>{" "}
                / New
              </div>
              <h1 className="mt-0.5 text-[28px] font-bold tracking-tight">New project</h1>
            </div>

            <section className={sec}>
              <h2 className={h2}>Source</h2>
              <Segmented
                className="w-max"
                value={mode}
                onChange={setMode}
                options={[
                  { value: "url", label: "Paste link" },
                  { value: "upload", label: "Upload file" },
                ]}
              />
              {mode === "url" ? (
                <>
                  <input className="input py-2.5" placeholder="https://youtube.com/watch?v=…" aria-label="Video link" value={url} onChange={(e) => setUrl(e.target.value)} required />
                  {(imgEl || peek.data?.title) && (
                    <div className="flex items-center gap-3 rounded-[12px] bg-sunk p-2">
                      <div className="film aspect-video w-24 shrink-0 overflow-hidden rounded-[8px]">{imgEl && <img src={imgEl.src} alt="" referrerPolicy="no-referrer" className="h-full w-full object-cover" />}</div>
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold">{peek.data?.title ?? "YouTube video"}</div>
                        <div className="text-xs text-ink3">{ytId ? "youtube.com" : (() => { try { return new URL(debouncedUrl).host; } catch { return ""; } })()}</div>
                      </div>
                    </div>
                  )}
                  {validUrl && !ytId && peek.isLoading && <div className="text-xs text-ink3">Fetching title and thumbnail…</div>}
                </>
              ) : (
                <>
                  <label
                    data-own-drop
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      const f = [...e.dataTransfer.files].find(isVideo);
                      if (f) setFile(f);
                    }}
                    className="flex cursor-pointer flex-col items-center gap-1 rounded-[12px] border-2 border-dashed border-line2 px-4 py-6 text-center text-sm text-ink2 hover:border-acc"
                  >
                    <span className="font-semibold text-ink">{file ? file.name : "Choose or drop a video file"}</span>
                    <span className="text-xs text-ink3">{file ? `${(file.size / 1e6).toFixed(0)} MB` : `MP4, MOV, MKV or WebM · up to ${status.data?.maxUploadMb ?? "—"} MB`}</span>
                    <input className="hidden" type="file" accept="video/*,.mkv,.mov,.mp4,.webm" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
                  </label>
                  {uploadPct !== null && (
                    <div className="flex items-center gap-3">
                      <ProgressBar value={uploadPct} className="flex-1" />
                      <button type="button" className="btn-quiet px-2 py-1 text-xs" onClick={() => uploadCtrl.current?.abort()}>
                        Cancel upload
                      </button>
                    </div>
                  )}
                  <video ref={hiddenVideo} src={objectUrl ?? undefined} muted playsInline preload="auto" className="hidden" />
                </>
              )}
              <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title (optional, defaults to the video title)" aria-label="Title" />
            </section>

            <section className={sec}>
              <h2 className={h2}>Clip length</h2>
              <div className="flex flex-wrap gap-2">
                {LENGTHS.map((l) => (
                  <button key={l.id} type="button" className={chip(lengthId === l.id)} onClick={() => patch({ minClipSeconds: l.min, maxClipSeconds: l.max })}>
                    {l.label}
                  </button>
                ))}
                <button type="button" className={chip(lengthId === "custom")} onClick={() => patch({ minClipSeconds: s.minClipSeconds + 1 })}>
                  Custom
                </button>
              </div>
              {lengthId === "custom" && (
                <div className="flex items-center gap-2 text-[13px] text-ink2">
                  Between
                  <input className="input w-16 px-2 py-1" type="number" min={5} max={180} value={s.minClipSeconds} onChange={(e) => patch({ minClipSeconds: Number(e.target.value) })} aria-label="Minimum seconds" />
                  and
                  <input className="input w-16 px-2 py-1" type="number" min={10} max={300} value={s.maxClipSeconds} onChange={(e) => patch({ maxClipSeconds: Number(e.target.value) })} aria-label="Maximum seconds" />
                  seconds
                </div>
              )}
            </section>

            <section className={sec}>
              <h2 className={h2}>How many</h2>
              <label className="flex cursor-pointer items-start gap-2.5 text-sm">
                <input type="radio" name="cnt" className="mt-1 accent-[var(--acc)]" checked={!s.maxClips} onChange={() => patch({ maxClips: undefined })} />
                <span>
                  <b>Every strong moment</b>
                  <br />
                  <span className="text-[13px] text-ink2">Weak moments are dropped, so you might get 3 clips or 30.</span>
                </span>
              </label>
              <label className="flex cursor-pointer items-center gap-2.5 text-sm">
                <input type="radio" name="cnt" className="accent-[var(--acc)]" checked={!!s.maxClips} onChange={() => patch({ maxClips: s.maxClips ?? 10 })} />
                <b>At most</b>
                <input className="input w-16 px-2 py-1" type="number" min={1} max={50} value={s.maxClips ?? 10} onFocus={() => !s.maxClips && patch({ maxClips: 10 })} onChange={(e) => patch({ maxClips: Math.max(1, Number(e.target.value)) })} aria-label="Maximum clips" />
                <span className="text-ink2">clips</span>
              </label>
            </section>

            <section className={sec}>
              <label htmlFor="focus" className={h2}>
                Focus <span className="text-xs font-normal text-ink3">optional</span>
              </label>
              <input id="focus" className="input" placeholder="Find clips about… e.g. pricing, hiring" value={s.focus ?? ""} onChange={(e) => patch({ focus: e.target.value || undefined })} maxLength={300} />
              <span className="text-xs text-ink3">Only on-topic moments are kept. Each clip also gets a relevance score.</span>
            </section>

            <section className={sec}>
              <h2 className={h2}>Captions</h2>
              <div className="flex flex-wrap gap-2">
                {(
                  [
                    ["karaoke", "Highlight"],
                    ["box", "Boxed"],
                    ["plain", "Outlined"],
                    ["none", "Off"],
                  ] as const
                ).map(([v, l]) => (
                  <button key={v} type="button" className={chip(style.captions === v)} onClick={() => patch({ captions: v })}>
                    {l}
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-x-6 gap-y-3 text-[13px]">
                {style.captions !== "none" && style.captions !== "plain" && (
                  <span className="flex items-center gap-2">
                    Highlight
                    {["#C6A8FF", "#FFD84D", "#5EE0A0", "#FFFFFF"].map((c) => (
                      <button
                        key={c}
                        type="button"
                        aria-label={`Highlight ${c}`}
                        onClick={() => patch({ highlightColor: c })}
                        className="h-6 w-6 rounded-full"
                        style={{ background: c, border: style.highlightColor.toUpperCase() === c ? "2px solid var(--ink)" : "2px solid var(--line)" }}
                      />
                    ))}
                  </span>
                )}
                <label className="flex cursor-pointer items-center gap-2">
                  <input type="checkbox" className="accent-[var(--acc)]" checked={style.showHook} onChange={(e) => patch({ showHook: e.target.checked })} /> Hook text
                </label>
              </div>
              <span className="text-xs text-ink3">This is the project default. Fine-tune size, words on screen and key words per clip in the editor.</span>
            </section>

            <section className={sec}>
              <div className="flex items-baseline justify-between gap-3">
                <h2 className={h2}>Intro and outro</h2>
                <Link to="/library" className="text-xs text-ink3 no-underline hover:text-ink">
                  Manage library →
                </Link>
              </div>
              {/* same height whether it is loading, empty or showing the pickers */}
              <div className="grid min-h-[84px] grid-cols-[4.5rem_minmax(0,1fr)] content-start items-center gap-x-3 gap-y-2">
                {library.data && libAssets.length > 0 ? (
                  (["intro", "outro"] as const).map((slot) => {
                    const dflt = me.data?.projectDefaults[`${slot}AssetId`];
                    return (
                      <SlotRow
                        key={slot}
                        slot={slot}
                        label={slot === "intro" ? "Intro" : "Outro"}
                        choice={chosen[slot]}
                        sec={bump[`${slot}Sec`]}
                        onChange={(c, v) => setBump((b) => ({ ...b, [slot]: c, [`${slot}Sec`]: v }))}
                        fixed={fixed(dflt)}
                        assets={libAssets}
                        known={[...libAssets, ...(library.data?.deleted ?? [])]}
                        defaultId={dflt}
                      />
                    );
                  })
                ) : library.data ? (
                  <p className="col-span-2 text-[13px] text-ink3">
                    No intros or outros yet · Add one in the{" "}
                    <Link to="/library" className="text-ink2 hover:text-ink">
                      Library
                    </Link>
                  </p>
                ) : library.isPending ? (
                  <>
                    {["Intro", "Outro"].map((l) => (
                      <div key={l} className="contents" aria-hidden>
                        <Skeleton className="h-3.5 w-10" />
                        <Skeleton className="h-[38px] w-full rounded-[10px]" />
                      </div>
                    ))}
                    <span className="sr-only" role="status">Loading intros and outros…</span>
                  </>
                ) : null}
              </div>
            </section>

            <section className={sec}>
              <button type="button" className="flex items-center gap-1.5 text-left text-[15px] font-bold" aria-expanded={more} onClick={() => setMore(!more)}>
                <ChevronRight className={`h-4 w-4 transition ${more ? "rotate-90" : ""}`} /> Advanced
              </button>
              {more && (
                <div className="flex flex-col gap-4">
                  <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-ink2">
                    Names and terms to spell correctly
                    <input className="input font-normal" placeholder="e.g. Copia, La Marzocco, Priyanka" value={s.vocabulary ?? ""} onChange={(e) => patch({ vocabulary: e.target.value || undefined })} />
                    <span className="text-xs font-normal text-ink3">Also pulled from the video title, description and tags.</span>
                  </label>
                  <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-ink2">
                    Extra instructions for the AI
                    <textarea className="input font-normal" rows={3} placeholder="e.g. Prefer stories over tips. Avoid sponsor reads." value={s.instructions ?? ""} onChange={(e) => patch({ instructions: e.target.value || undefined })} />
                  </label>
                  <div className="flex flex-col gap-1.5">
                    <span className="text-[13px] font-semibold text-ink2">Pauses</span>
                    <Segmented
                      className="w-max"
                      size="sm"
                      value={s.pauses}
                      onChange={(v) => patch({ pauses: v })}
                      options={[
                        { value: "natural", label: "Natural", title: "Pauses longer than 0.6 s are shortened" },
                        { value: "tight", label: "Tight", title: "Pauses longer than 0.35 s are shortened" },
                        { value: "off", label: "Keep", title: "Leave pauses as recorded" },
                      ]}
                    />
                    <span className="text-xs text-ink3">Long silences are shortened with jump cuts, like disfluencies.</span>
                  </div>
                  <label className="flex cursor-pointer items-start gap-2.5 text-sm">
                    <input type="checkbox" className="mt-1 accent-[var(--acc)]" checked={s.sourceText !== "keep"} onChange={(e) => patch({ sourceText: e.target.checked ? "hide" : "keep" })} />
                    <span>
                      <b>Hide captions and logos already burned into the video</b>
                      <br />
                      <span className="text-[13px] text-ink2">Detected automatically. You can turn this off per project later.</span>
                    </span>
                  </label>
                  <div className="flex flex-col gap-1.5 border-t border-line pt-4">
                    <span className="text-[13px] font-semibold text-ink2">Refine after transcription</span>
                    <span className="text-xs text-ink3">Name fixes and the on-screen text scan run by default; filler removal is off for speed and cost (the server must allow a step under Settings → System → Pipeline).</span>
                    <RefineToggles compact value={s} onChange={patch} />
                  </div>
                </div>
              )}
            </section>
          </div>

          <aside className="lg:order-last">
            <div className="flex flex-col items-center gap-3 lg:sticky lg:top-7">
              <div className="h-[400px] w-full sm:h-[540px]">
                <LoopingPreview
                  source={source}
                  srcW={srcDims.w}
                  srcH={srcDims.h}
                  framing={{ layout: previewAs, cx: 0.5, cy: 0.4, cx2: 0.5 }}
                  style={style}
                  words={SAMPLE_WORDS}
                  hook="Your hook goes here"
                  emphasis={["captions", "every"]}
                  alwaysShowHook
                  onStyleChange={(p) => patch(p)}
                  showSafeZones={safe}
                  tag={source ? undefined : "preview"}
                />
              </div>
              <div className="text-xs text-ink3">Drag the caption or hook to position them. They snap to centre.</div>
              <Segmented
                size="sm"
                value={previewAs}
                onChange={setPreviewAs}
                options={[
                  { value: "face", label: "Speaker" },
                  { value: "split", label: "Two" },
                  { value: "stack", label: "Screen" },
                  { value: "fit", label: "Whole" },
                ]}
              />
              <span className="text-center text-xs leading-snug text-ink3">Preview only. Framing is chosen automatically per section; you can override it per clip later.</span>
              <label className="flex cursor-pointer items-center gap-2 text-[13px]">
                <input type="checkbox" className="accent-[var(--acc)]" checked={safe} onChange={(e) => setSafe(e.target.checked)} /> Show platform safe zones
              </label>
            </div>
          </aside>
        </main>
      </ScrollArea>

      <div className="shrink-0 border-t border-line bg-panel px-4 py-3 sm:px-6">
        <div className="mx-auto flex max-w-[1120px] flex-wrap items-center gap-3">
          <span className="min-w-0 flex-1 text-[13px] text-ink2">
            {create.error ? <QuotaNotice message={create.error.message} quota={quotaFromError(create.error)} /> : uploadPct !== null ? `Uploading… ${Math.round(uploadPct * 100)}%` : <span className="truncate">{summary}</span>}
          </span>
          <button
            type="button"
            className="btn-quiet text-xs"
            title="Keep these settings for every new project"
            disabled={busy || saveDefaults.isPending}
            onClick={() => saveDefaults.mutate(userProjectDefaultsSchema.parse(s), { onSuccess: () => toast("Saved as your defaults"), onError: (e) => toast.error(e.message) })}
          >
            Save as my defaults
          </button>
          <Link to="/" className="btn-quiet no-underline">
            Cancel
          </Link>
          <button className="btn-primary px-5 py-2.5 text-sm" disabled={busy || !canStart}>
            {busy ? "Starting…" : "Find clips"}
          </button>
        </div>
      </div>
    </form>
  );
}

/** Owns the animation clock so only the preview re-renders every frame, not the whole form. */
function LoopingPreview(props: Omit<React.ComponentProps<typeof VerticalPreview>, "time">) {
  const [time, setTime] = useState(0);
  useEffect(() => {
    let raf = 0;
    const t0 = performance.now();
    const tick = () => {
      setTime(((performance.now() - t0) / 1000) % SAMPLE_LOOP);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return <VerticalPreview {...props} time={time} />;
}
