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
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import {
  CLEARABLE_SETTINGS,
  defaultProjectSettings,
  formatNumber,
  projectSettingsSchema,
  SOURCE_URL_PARAM,
  userProjectDefaultsSchema,
  styleSchema,
  type ClearableSetting,
  type ProjectSettings,
  type QuotaRefusal,
  type Style,
} from "@reelsaw/shared";
import { VerticalPreview, type PreviewLayout, type PreviewWord } from "../components/VerticalPreview";
import { RefineToggles } from "../components/RefineToggles";
import { LanguageCombobox } from "../components/LanguageCombobox";
import { youtubeId } from "../lib/links";
import { QuotaNotice, quotaFromError } from "../components/QuotaNotice";
import { pageTitle, useDocumentTitle } from "../lib/title";
import { useDebounced } from "../lib/useDebounced";

const LENGTHS = [
  { id: "short", label: msg`< 30s`, min: 10, max: 30 },
  { id: "medium", label: msg`20–60s`, min: 20, max: 60 },
  { id: "long", label: msg`45–90s`, min: 45, max: 90 },
  { id: "xl", label: msg`1–3 min`, min: 60, max: 180 },
] as const;

const SAMPLE = msg`This is how your captions will look on every clip you make`;
/** The sample caption, timed word by word, and how long one loop of it lasts. */
function sampleWords(text: string): { words: PreviewWord[]; loop: number } {
  const words = text
    .split(/\s+/)
    .filter(Boolean)
    .map((w, i) => ({ text: w, start: i * 0.38, end: i * 0.38 + 0.34 }));
  return { words, loop: (words.at(-1)?.end ?? 0) + 0.6 };
}

export function NewProjectPage() {
  const { t, i18n } = useLingui();
  useDocumentTitle(pageTitle(t`New project`));
  const sample = useMemo(() => sampleWords(i18n._(SAMPLE)), [i18n]);
  const trpc = useTRPC();
  const client = useTRPCClient();
  const nav = useNavigate();
  const qc = useQueryClient();
  const status = useSystemStatus();
  const me = useMe();
  const uploadCtrl = useRef<AbortController | null>(null);
  const create = useMutation({
    mutationFn: async (input: {
      title?: string | undefined;
      sourceUrl?: string | undefined;
      file?: File;
      settings: ProjectSettings;
      clear: ClearableSetting[];
    }) => {
      uploadCtrl.current = new AbortController();
      const uploadId = input.file ? await postUpload(input.file, setUploadPct, uploadCtrl.current.signal) : undefined;
      return client.projects.create.mutate({ title: input.title, sourceUrl: input.sourceUrl, uploadId, settings: input.settings, clear: input.clear });
    },
    onSettled: () => setUploadPct(null),
  });
  const saveDefaults = useMutation({
    ...trpc.me.updateProjectDefaults.mutationOptions(),
    onSuccess: () => void qc.invalidateQueries({ queryKey: trpc.me.pathKey() }),
  });

  // prefilled from ⌘K or the website's hero box through sign-up (?url=, newProjectPath) or a single video dropped anywhere in the app
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
  const [url, setUrl] = useState(() => search.get(SOURCE_URL_PARAM) ?? "");
  useEffect(() => {
    const f = takePendingFile();
    if (f) {
      setFileRaw(f);
      setMode("upload");
    }
    const u = search.get(SOURCE_URL_PARAM);
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
  const [bump, setBump] = useState<{ intro: string; outro: string; introSec?: number; outroSec?: number }>(() => ({
    intro: search.get("intro") || "default",
    outro: search.get("outro") || "default",
  }));
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
    const candidates = ytId
      ? [`https://i.ytimg.com/vi/${ytId}/maxresdefault.jpg`, `https://i.ytimg.com/vi/${ytId}/hqdefault.jpg`]
      : peek.data?.thumbnail
        ? [peek.data.thumbnail]
        : [];
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
  // the picked file's length, so the minutes check runs before minutes of uploading, not after
  const [fileSec, setFileSec] = useState<number | null>(null);
  useEffect(() => {
    const v = hiddenVideo.current;
    setFileSec(null);
    if (!v || !objectUrl) return setVideoEl(null);
    const onMeta = () => {
      v.currentTime = Math.min(30, (v.duration || 10) * 0.2);
      setSrcDims({ w: v.videoWidth, h: v.videoHeight });
      if (Number.isFinite(v.duration) && v.duration > 0) setFileSec(v.duration);
    };
    const onSeeked = () => setVideoEl(v);
    v.addEventListener("loadedmetadata", onMeta);
    v.addEventListener("seeked", onSeeked);
    return () => {
      v.removeEventListener("loadedmetadata", onMeta);
      v.removeEventListener("seeked", onSeeked);
    };
  }, [objectUrl]);

  // Would this source be accepted? The same checks creating it runs (minutes, projects, storage), asked before submit, so a
  // video the plan cannot cover is said up front with the upgrade offer instead of failing after the click (or the upload).
  const checkInput = mode === "url" ? (validUrl ? { sourceUrl: debouncedUrl } : null) : fileSec ? { durationSec: Math.ceil(fileSec) } : null;
  const check = useQuery({
    ...trpc.projects.checkSource.queryOptions(checkInput ?? { durationSec: 1 }),
    enabled: !!checkInput,
    staleTime: 60_000,
    retry: false,
  });
  // a link still being typed has not been checked yet; neither has a file whose length is not read yet
  const fit = checkInput && (mode === "upload" || debouncedUrl === url) ? check.data : undefined;
  const blocked = fit?.fits === false;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (mode === "upload" && !file) return;
    if (blocked) return;
    const tooBig = mode === "upload" && file ? uploadSizeProblem(file, maxMb) : null;
    if (tooBig) return void toast.error(tooBig);
    create.mutate(
      {
        title: title || undefined,
        sourceUrl: mode === "url" ? url : undefined,
        ...(mode === "upload" && file ? { file } : {}),
        settings: { ...s, ...bumperSettings },
        // the form starts from the saved defaults, so an optional setting left empty here was cleared on purpose
        // ("Detect automatically", no focus): without this the server would fill it back in from the defaults
        clear: CLEARABLE_SETTINGS.filter((k) => s[k] === undefined),
      },
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
  const defaultName = (id: string | undefined) =>
    id ? ([...libAssets, ...(library.data?.deleted ?? [])].find((a) => a.id === id)?.name ?? t`deleted`) : t`none`;
  const fixed = (id: string | undefined): FixedOption[] => {
    const current = defaultName(id);
    return [
      { value: "default", label: t`Your default (${current})`, hint: t`What Settings say now`, icon: <Star className="h-4 w-4" /> },
      { value: "none", label: t`None`, hint: t`Nothing here`, icon: <Ban className="h-4 w-4" /> },
    ];
  };

  const busy = create.isPending;
  const maxUploadText = status.data?.maxUploadMb !== undefined ? formatNumber(status.data.maxUploadMb) : "—";
  const lengthId = LENGTHS.find((l) => l.min === s.minClipSeconds && l.max === s.maxClipSeconds)?.id ?? "custom";
  const source = mode === "upload" ? videoEl : imgEl;

  const sec = "flex flex-col gap-3 rounded-[16px] border border-line bg-panel p-5";
  const h2 = "text-[15px] font-bold";
  const minSec = s.minClipSeconds;
  const maxSec = s.maxClipSeconds;
  const lenLabel = lengthId === "custom" ? t`${minSec}–${maxSec}s` : i18n._(LENGTHS.find((l) => l.id === lengthId)!.label);
  const look = { karaoke: t`Highlight captions`, box: t`Boxed captions`, plain: t`Outlined captions`, none: t`No captions` }[style.captions];
  const maxClips = s.maxClips;
  const focus = s.focus;
  const howMany = maxClips ? t`At most ${maxClips} clips` : t`Every strong moment`;
  const summary = focus ? t`${howMany} · ${lenLabel} · ${look} · about “${focus}”` : `${howMany} · ${lenLabel} · ${look}`;
  const uploadPctText = uploadPct !== null ? Math.round(uploadPct * 100) : 0;
  const canStart = mode === "url" ? /^https?:\/\/\S+\.\S+/.test(url) : !!file;
  const chip = (on: boolean) =>
    `rounded-full border px-3.5 py-1.5 text-[13px] font-semibold ${on ? "border-ink bg-ink text-bg" : "border-line bg-panel text-ink2 hover:text-ink"}`;

  return (
    <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
      <ScrollArea className="min-h-0 flex-1">
        <main className="mx-auto grid max-w-[1120px] gap-6 px-4 py-7 sm:px-6 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="flex min-w-0 flex-col gap-4">
            <div>
              <div className="text-xs text-ink3">
                <Trans>
                  <Link to="/" className="text-ink3 no-underline hover:text-ink">
                    Projects
                  </Link>{" "}
                  / New
                </Trans>
              </div>
              <h1 className="mt-0.5 text-[28px] font-bold tracking-tight">
                <Trans>New project</Trans>
              </h1>
            </div>

            <section className={sec}>
              <h2 className={h2}>
                <Trans>Source</Trans>
              </h2>
              <Segmented
                className="w-max"
                value={mode}
                onChange={setMode}
                options={[
                  { value: "url", label: t`Paste link` },
                  { value: "upload", label: t`Upload file` },
                ]}
              />
              {mode === "url" ? (
                <>
                  <input
                    className="input py-2.5"
                    placeholder={t`https://youtube.com/watch?v=…`}
                    aria-label={t`Video link`}
                    value={url}
                    onChange={(e) => setUrl(e.target.value)}
                    required
                  />
                  {(imgEl || peek.data?.title) && (
                    <div className="flex items-center gap-3 rounded-[12px] bg-sunk p-2">
                      <div className="film aspect-video w-24 shrink-0 overflow-hidden rounded-[8px]">
                        {imgEl && <img src={imgEl.src} alt="" referrerPolicy="no-referrer" className="h-full w-full object-cover" />}
                      </div>
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold">{peek.data?.title ?? t`YouTube video`}</div>
                        <div className="text-xs text-ink3">
                          {ytId
                            ? "youtube.com"
                            : (() => {
                                try {
                                  return new URL(debouncedUrl).host;
                                } catch {
                                  return "";
                                }
                              })()}
                        </div>
                      </div>
                    </div>
                  )}
                  {validUrl && !ytId && peek.isLoading && (
                    <div className="text-xs text-ink3">
                      <Trans>Fetching title and thumbnail…</Trans>
                    </div>
                  )}
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
                    <span className="font-semibold text-ink">{file ? file.name : t`Choose or drop a video file`}</span>
                    <span className="text-xs text-ink3">
                      {file ? `${formatNumber(Math.round(file.size / 1e6))} MB` : t`MP4, MOV, MKV or WebM · up to ${maxUploadText} MB`}
                    </span>
                    <input className="hidden" type="file" accept="video/*,.mkv,.mov,.mp4,.webm" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
                  </label>
                  {uploadPct !== null && (
                    <div className="flex items-center gap-3">
                      <ProgressBar value={uploadPct} className="flex-1" />
                      <button type="button" className="btn-quiet px-2 py-1 text-xs" onClick={() => uploadCtrl.current?.abort()}>
                        <Trans>Cancel upload</Trans>
                      </button>
                    </div>
                  )}
                  <video ref={hiddenVideo} src={objectUrl ?? undefined} muted playsInline preload="auto" className="hidden" />
                </>
              )}
              {checkInput && check.isFetching && !fit && (
                <div className="text-xs text-ink3">
                  <Trans>Checking the video’s length against your plan…</Trans>
                </div>
              )}
              {fit && <SourceFit fit={fit} />}
              <input
                className="input"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={t`Title (optional, defaults to the video title)`}
                aria-label={t`Title`}
              />
            </section>

            <section className={sec}>
              <h2 className={h2}>
                <Trans>Clip length</Trans>
              </h2>
              <div className="flex flex-wrap gap-2">
                {LENGTHS.map((l) => (
                  <button key={l.id} type="button" className={chip(lengthId === l.id)} onClick={() => patch({ minClipSeconds: l.min, maxClipSeconds: l.max })}>
                    {i18n._(l.label)}
                  </button>
                ))}
                <button type="button" className={chip(lengthId === "custom")} onClick={() => patch({ minClipSeconds: s.minClipSeconds + 1 })}>
                  <Trans>Custom</Trans>
                </button>
              </div>
              {lengthId === "custom" && (
                <div className="flex items-center gap-2 text-[13px] text-ink2">
                  <Trans>
                    Between
                    <input
                      className="input w-16 px-2 py-1"
                      type="number"
                      min={5}
                      max={180}
                      value={s.minClipSeconds}
                      onChange={(e) => patch({ minClipSeconds: Number(e.target.value) })}
                      aria-label={t`Minimum seconds`}
                    />
                    and
                    <input
                      className="input w-16 px-2 py-1"
                      type="number"
                      min={10}
                      max={300}
                      value={s.maxClipSeconds}
                      onChange={(e) => patch({ maxClipSeconds: Number(e.target.value) })}
                      aria-label={t`Maximum seconds`}
                    />
                    seconds
                  </Trans>
                </div>
              )}
            </section>

            <section className={sec}>
              <h2 className={h2}>
                <Trans>How many</Trans>
              </h2>
              <label className="flex cursor-pointer items-start gap-2.5 text-sm">
                <input type="radio" name="cnt" className="mt-1 accent-[var(--acc)]" checked={!s.maxClips} onChange={() => patch({ maxClips: undefined })} />
                <span>
                  <b>
                    <Trans>Every strong moment</Trans>
                  </b>
                  <br />
                  <span className="text-[13px] text-ink2">
                    <Trans>Weak moments are dropped, so you might get 3 clips or 30.</Trans>
                  </span>
                </span>
              </label>
              <label className="flex cursor-pointer items-center gap-2.5 text-sm">
                <input type="radio" name="cnt" className="accent-[var(--acc)]" checked={!!s.maxClips} onChange={() => patch({ maxClips: s.maxClips ?? 10 })} />
                <Trans>
                  <b>At most</b>
                  <input
                    className="input w-16 px-2 py-1"
                    type="number"
                    min={1}
                    max={50}
                    value={s.maxClips ?? 10}
                    onFocus={() => !s.maxClips && patch({ maxClips: 10 })}
                    onChange={(e) => patch({ maxClips: Math.max(1, Number(e.target.value)) })}
                    aria-label={t`Maximum clips`}
                  />
                  <span className="text-ink2">clips</span>
                </Trans>
              </label>
            </section>

            <section className={sec}>
              <label htmlFor="focus" className={h2}>
                <Trans>
                  Focus <span className="text-xs font-normal text-ink3">optional</span>
                </Trans>
              </label>
              <input
                id="focus"
                className="input"
                placeholder={t`Find clips about… e.g. pricing, hiring`}
                value={s.focus ?? ""}
                onChange={(e) => patch({ focus: e.target.value || undefined })}
                maxLength={300}
              />
              <span className="text-xs text-ink3">
                <Trans>Only on-topic moments are kept. Each clip also gets a relevance score.</Trans>
              </span>
            </section>

            <section className={sec}>
              <h2 className={h2}>
                <Trans>Captions</Trans>
              </h2>
              <div className="flex flex-wrap gap-2">
                {(
                  [
                    ["karaoke", t`Highlight`],
                    ["box", t`Boxed`],
                    ["plain", t`Outlined`],
                    ["none", t`Off`],
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
                    <Trans>Highlight</Trans>
                    {["#C6A8FF", "#FFD84D", "#5EE0A0", "#FFFFFF"].map((c) => (
                      <button
                        key={c}
                        type="button"
                        aria-label={t`Highlight ${c}`}
                        onClick={() => patch({ highlightColor: c })}
                        className="h-6 w-6 rounded-full"
                        style={{ background: c, border: style.highlightColor.toUpperCase() === c ? "2px solid var(--ink)" : "2px solid var(--line)" }}
                      />
                    ))}
                  </span>
                )}
                <label className="flex cursor-pointer items-center gap-2">
                  <input type="checkbox" className="accent-[var(--acc)]" checked={style.showHook} onChange={(e) => patch({ showHook: e.target.checked })} />{" "}
                  <Trans>Hook text</Trans>
                </label>
              </div>
              <span className="text-xs text-ink3">
                <Trans>This is the project default. Fine-tune size, words on screen and key words per clip in the editor.</Trans>
              </span>
            </section>

            <section className={sec}>
              <div className="flex items-baseline justify-between gap-3">
                <h2 className={h2}>
                  <Trans>Intro and outro</Trans>
                </h2>
                <Link to="/library" className="text-xs text-ink3 no-underline hover:text-ink">
                  <Trans>Manage library →</Trans>
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
                        label={slot === "intro" ? t`Intro` : t`Outro`}
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
                    <Trans>
                      No intros or outros yet · Add one in the{" "}
                      <Link to="/library" className="text-ink2 hover:text-ink">
                        Library
                      </Link>
                    </Trans>
                  </p>
                ) : library.isPending ? (
                  <>
                    {["Intro", "Outro"].map((l) => (
                      <div key={l} className="contents" aria-hidden>
                        <Skeleton className="h-3.5 w-10" />
                        <Skeleton className="h-[38px] w-full rounded-[10px]" />
                      </div>
                    ))}
                    <span className="sr-only" role="status">
                      <Trans>Loading intros and outros…</Trans>
                    </span>
                  </>
                ) : null}
              </div>
            </section>

            <section className={sec}>
              <button type="button" className="flex items-center gap-1.5 text-start text-[15px] font-bold" aria-expanded={more} onClick={() => setMore(!more)}>
                <ChevronRight className={`h-4 w-4 transition ${more ? "rotate-90" : ""}`} /> <Trans>Advanced</Trans>
              </button>
              {more && (
                <div className="flex flex-col gap-4">
                  <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-ink2">
                    <Trans>Names and terms to spell correctly</Trans>
                    <input
                      className="input font-normal"
                      placeholder={t`e.g. Copia, La Marzocco, Priyanka`}
                      value={s.vocabulary ?? ""}
                      onChange={(e) => patch({ vocabulary: e.target.value || undefined })}
                    />
                    <span className="text-xs font-normal text-ink3">
                      <Trans>Also pulled from the video title, description and tags.</Trans>
                    </span>
                  </label>
                  <div className="flex flex-col gap-1.5">
                    <span className="text-[13px] font-semibold text-ink2">
                      <Trans>Spoken language</Trans>
                    </span>
                    <LanguageCombobox className="sm:max-w-xs" value={s.language} onValueChange={(v) => patch({ language: v })} />
                    <span className="text-xs text-ink3">
                      <Trans>Set it when the video opens with music or another language, so the transcript is not guessed wrong.</Trans>
                    </span>
                  </div>
                  <label className="flex flex-col gap-1.5 text-[13px] font-semibold text-ink2">
                    <Trans>Extra instructions for the AI</Trans>
                    <textarea
                      className="input font-normal"
                      rows={3}
                      placeholder={t`e.g. Prefer stories over tips. Avoid sponsor reads.`}
                      value={s.instructions ?? ""}
                      onChange={(e) => patch({ instructions: e.target.value || undefined })}
                    />
                  </label>
                  <div className="flex flex-col gap-1.5">
                    <span className="text-[13px] font-semibold text-ink2">
                      <Trans>Pauses</Trans>
                    </span>
                    <Segmented
                      className="w-max"
                      size="sm"
                      value={s.pauses}
                      onChange={(v) => patch({ pauses: v })}
                      options={[
                        { value: "natural", label: t`Natural`, title: t`Pauses longer than 0.6 s are shortened` },
                        { value: "tight", label: t`Tight`, title: t`Pauses longer than 0.35 s are shortened` },
                        { value: "off", label: t`Keep`, title: t`Leave pauses as recorded` },
                      ]}
                    />
                    <span className="text-xs text-ink3">
                      <Trans>Long silences are shortened with jump cuts, like disfluencies.</Trans>
                    </span>
                  </div>
                  <label className="flex cursor-pointer items-start gap-2.5 text-sm">
                    <input
                      type="checkbox"
                      className="mt-1 accent-[var(--acc)]"
                      checked={s.sourceText !== "keep"}
                      onChange={(e) => patch({ sourceText: e.target.checked ? "hide" : "keep" })}
                    />
                    <span>
                      <b>
                        <Trans>Hide captions and logos already burned into the video</Trans>
                      </b>
                      <br />
                      <span className="text-[13px] text-ink2">
                        <Trans>Detected automatically. You can turn this off per project later.</Trans>
                      </span>
                    </span>
                  </label>
                  <div className="flex flex-col gap-1.5 border-t border-line pt-4">
                    <span className="text-[13px] font-semibold text-ink2">
                      <Trans>Refine after transcription</Trans>
                    </span>
                    <span className="text-xs text-ink3">
                      <Trans>
                        Name fixes and the on-screen text scan run by default; filler removal is off for speed and cost (the server must allow a step under
                        Settings → System → Pipeline).
                      </Trans>
                    </span>
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
                  words={sample.words}
                  loop={sample.loop}
                  hook={t`Your hook goes here`}
                  emphasis={["captions", "every"]}
                  alwaysShowHook
                  onStyleChange={(p) => patch(p)}
                  showSafeZones={safe}
                  tag={source ? undefined : t`preview`}
                />
              </div>
              <div className="text-xs text-ink3">
                <Trans>Drag the caption or hook to position them. They snap to centre.</Trans>
              </div>
              <Segmented
                size="sm"
                value={previewAs}
                onChange={setPreviewAs}
                options={[
                  { value: "face", label: t`Speaker` },
                  { value: "split", label: t`Two` },
                  { value: "stack", label: t`Screen` },
                  { value: "fit", label: t`Whole` },
                ]}
              />
              <span className="text-center text-xs leading-snug text-ink3">
                <Trans>Preview only. Framing is chosen automatically per section; you can override it per clip later.</Trans>
              </span>
              <label className="flex cursor-pointer items-center gap-2 text-[13px]">
                <input type="checkbox" className="accent-[var(--acc)]" checked={safe} onChange={(e) => setSafe(e.target.checked)} />{" "}
                <Trans>Show platform safe zones</Trans>
              </label>
            </div>
          </aside>
        </main>
      </ScrollArea>

      <div className="shrink-0 border-t border-line bg-panel px-4 py-3 sm:px-6">
        <div className="mx-auto flex max-w-[1120px] flex-wrap items-center gap-3">
          <span className="min-w-0 flex-1 text-[13px] text-ink2">
            {create.error ? (
              <QuotaNotice message={create.error.message} quota={quotaFromError(create.error)} />
            ) : uploadPct !== null ? (
              t`Uploading… ${uploadPctText}%`
            ) : (
              <span className="truncate">{summary}</span>
            )}
          </span>
          <button
            type="button"
            className="btn-quiet text-xs"
            title={t`Keep these settings for every new project`}
            disabled={busy || saveDefaults.isPending}
            onClick={() =>
              saveDefaults.mutate(userProjectDefaultsSchema.parse(s), {
                onSuccess: () => toast(t`Saved as your defaults`),
                onError: (e) => toast.error(e.message),
              })
            }
          >
            <Trans>Save as my defaults</Trans>
          </button>
          <Link to="/" className="btn-quiet no-underline">
            <Trans>Cancel</Trans>
          </Link>
          <button
            className="btn-primary px-5 py-2.5 text-sm"
            disabled={busy || !canStart || blocked}
            title={blocked ? t`This video doesn’t fit your plan’s minutes; see the note under the source` : undefined}
          >
            {busy ? t`Starting…` : t`Find clips`}
          </button>
        </div>
      </div>
    </form>
  );
}

type SourceCheck = {
  minutes: number | null;
  /** accepted, but only the first `minutes` are processed now (the server's SourcePartial) */
  partial: { minutes: number; totalMinutes: number; firstVideo: boolean; sentence: string; upgrade: { label: string; href: string } | null } | null;
  fits: boolean | null;
  message: string | null;
  quota: QuotaRefusal | null;
  allowance: { perMonth: number; left: number; firstVideoFree: number; resetsOn: string } | null;
};

/** Under the source: the refusal it would meet (with the upgrade offer), else what the plan's minutes cover. Nothing without a minutes limit. */
function SourceFit({ fit }: { fit: SourceCheck }) {
  const { t } = useLingui();
  if (fit.fits === false && fit.message) return <QuotaNotice message={fit.message} quota={fit.quota} placement="precheck" />;
  if (fit.partial) return <PartialFit partial={fit.partial} />;
  const a = fit.allowance;
  if (!a) return null;
  const minutes = fit.minutes !== null ? formatNumber(Math.round(fit.minutes)) : null;
  const free = formatNumber(a.firstVideoFree);
  const perMonth = formatNumber(a.perMonth);
  const left = formatNumber(a.left);
  const plan = a.firstVideoFree
    ? t`Your first video is free up to ${free} minutes, then ${perMonth} minutes a month.`
    : t`${left} of your ${perMonth} minutes left this month.`;
  return <div className="text-xs text-ink3">{minutes !== null ? t`${minutes}-minute video. ${plan}` : plan}</div>;
}

/**
 * A long video the plan's minutes cover only the start of: it is not refused. Says how much is clipped now and offers
 * the plan that covers all of it (upgrading before the project starts clips the whole video; later, the project page's offer finishes it).
 */
function PartialFit({ partial }: { partial: NonNullable<SourceCheck["partial"]> }) {
  const shown = !!partial.upgrade;
  useEffect(() => {
    if (shown) track("upgrade_offer_shown", { placement: "partial_precheck", minutes: partial.minutes, totalMinutes: partial.totalMinutes });
  }, [shown, partial.minutes, partial.totalMinutes]);
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="text-[13px] leading-snug text-ink2">{partial.sentence}</p>
      {partial.upgrade && (
        <div>
          <a
            href={partial.upgrade.href}
            className="btn-ghost py-1.5 text-xs no-underline"
            onClick={() => track("upgrade_clicked", { placement: "partial_precheck", minutes: partial.minutes, totalMinutes: partial.totalMinutes })}
          >
            {partial.upgrade.label}
          </a>
        </div>
      )}
    </div>
  );
}

/** Owns the animation clock so only the preview re-renders every frame, not the whole form. */
function LoopingPreview({ loop, ...props }: Omit<React.ComponentProps<typeof VerticalPreview>, "time"> & { loop: number }) {
  const [time, setTime] = useState(0);
  useEffect(() => {
    let raf = 0;
    const t0 = performance.now();
    const tick = () => {
      setTime(((performance.now() - t0) / 1000) % loop);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [loop]);
  return <VerticalPreview {...props} time={time} />;
}
