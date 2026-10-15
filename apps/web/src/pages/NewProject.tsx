import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { Upload, Link2, ShieldAlert, ChevronDown } from "lucide-react";
import { useTRPC } from "../lib/trpc";
import { defaultProjectSettings, styleSchema, type ProjectSettings, type Style } from "@reelsaw/shared";
import { VerticalPreview, type PreviewLayout, type PreviewWord } from "../components/VerticalPreview";
import { StyleControls, Segmented } from "../components/StyleControls";

const LENGTHS = [
  { id: "short", label: "< 30s", min: 10, max: 30 },
  { id: "medium", label: "20–60s", min: 20, max: 60 },
  { id: "long", label: "45–90s", min: 45, max: 90 },
  { id: "xl", label: "1–3 min", min: 60, max: 180 },
] as const;

const SAMPLE = "This is how your captions will look on every clip you make".split(" ");
const SAMPLE_WORDS: PreviewWord[] = SAMPLE.map((text, i) => ({ text, start: i * 0.38, end: i * 0.38 + 0.34 }));
const SAMPLE_LOOP = SAMPLE_WORDS.at(-1)!.end + 0.6;

function youtubeId(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\.|^m\./, "");
    if (host === "youtu.be") return u.pathname.slice(1) || null;
    if (host.endsWith("youtube.com")) return u.searchParams.get("v") ?? /^\/(?:shorts|live|embed)\/([\w-]+)/.exec(u.pathname)?.[1] ?? null;
  } catch {
    /* not a url yet */
  }
  return null;
}

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
  const nav = useNavigate();
  const settingsQ = useQuery(trpc.settings.get.queryOptions());
  const create = useMutation(trpc.projects.create.mutationOptions());

  const [mode, setMode] = useState<"url" | "upload">("url");
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [s, setS] = useState<ProjectSettings>(defaultProjectSettings);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
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

  function uploadFile(f: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/upload");
      xhr.withCredentials = true;
      xhr.setRequestHeader("x-filename", encodeURIComponent(f.name));
      xhr.setRequestHeader("Content-Type", f.type || "application/octet-stream");
      xhr.upload.onprogress = (e) => e.lengthComputable && setUploadPct(e.loaded / e.total);
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve((JSON.parse(xhr.responseText) as { uploadId: string }).uploadId);
        else reject(new Error(xhr.responseText || `upload failed (${xhr.status})`));
      };
      xhr.onerror = () => reject(new Error("upload failed"));
      xhr.send(f);
    });
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      let uploadId: string | undefined;
      if (mode === "upload") {
        if (!file) throw new Error("Pick a video file");
        uploadId = await uploadFile(file);
      }
      const p = await create.mutateAsync({ title: title || undefined, sourceUrl: mode === "url" ? url : undefined, uploadId, settings: s });
      nav(`/p/${p.id}`);
    } catch (err) {
      setError((err as Error).message);
      setUploadPct(null);
    }
  }

  const busy = create.isPending || uploadPct !== null;
  const lengthId = LENGTHS.find((l) => l.min === s.minClipSeconds && l.max === s.maxClipSeconds)?.id ?? "custom";
  const source = mode === "upload" ? videoEl : imgEl;

  return (
    <form onSubmit={submit} className="mx-auto max-w-5xl">
      <h1 className="mb-4 text-xl font-semibold">New project</h1>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        {/* preview: first on mobile, sticky on the right on desktop */}
        <div className="order-first lg:order-last">
          <div className="space-y-2 lg:sticky lg:top-0">
            <div className="h-[460px] sm:h-[540px]">
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
              />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Segmented
                value={previewAs}
                onChange={setPreviewAs}
                options={[
                  { value: "face", label: "Face", title: "Speaker crop" },
                  { value: "split", label: "Split", title: "Two speakers" },
                  { value: "stack", label: "Stack", title: "Screen + webcam" },
                  { value: "fit", label: "Fit", title: "Whole frame, blurred background" },
                ]}
              />
              <button type="button" className={`btn-ghost px-2 py-1 text-xs ${safe ? "text-danger" : ""}`} onClick={() => setSafe(!safe)} title="Show where TikTok / Shorts / Reels draw their buttons and description">
                <ShieldAlert className="h-3.5 w-3.5" /> Safe zones
              </button>
            </div>
            <p className="text-xs text-muted">Framing is chosen automatically per scene. Override any section in the clip editor afterwards.</p>
          </div>
        </div>

        <div className="space-y-4">
          <section className="card space-y-3 p-4">
            <div className="flex gap-2">
              <button type="button" className={mode === "url" ? "btn-primary" : "btn-ghost"} onClick={() => setMode("url")}>
                <Link2 className="h-4 w-4" /> URL
              </button>
              <button type="button" className={mode === "upload" ? "btn-primary" : "btn-ghost"} onClick={() => setMode("upload")}>
                <Upload className="h-4 w-4" /> Upload
              </button>
            </div>
            {mode === "url" ? (
              <div>
                <label className="label">Video URL</label>
                <input className="input" placeholder="https://www.youtube.com/watch?v=…" value={url} onChange={(e) => setUrl(e.target.value)} required />
                {peek.data?.title && !ytId && <p className="mt-1 truncate text-xs text-muted">{peek.data.title}</p>}
              </div>
            ) : (
              <div>
                <label className="label">Video file (max {settingsQ.data?.maxUploadMb ?? "—"} MB)</label>
                <input className="input" type="file" accept="video/*,.mkv,.mov,.mp4,.webm" onChange={(e) => setFile(e.target.files?.[0] ?? null)} required />
                {uploadPct !== null && <p className="mt-2 text-xs text-muted">Uploading… {Math.round(uploadPct * 100)}%</p>}
                <video ref={hiddenVideo} src={objectUrl ?? undefined} muted playsInline preload="auto" className="hidden" />
              </div>
            )}
            <div>
              <label className="label">Title (optional)</label>
              <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Defaults to the video title" />
            </div>
          </section>

          <section className="card space-y-4 p-4">
            <h2 className="text-sm font-semibold">Clips</h2>
            <div>
              <label className="label">Length</label>
              <Segmented
                value={lengthId}
                onChange={(id) => {
                  const l = LENGTHS.find((x) => x.id === id);
                  if (l) patch({ minClipSeconds: l.min, maxClipSeconds: l.max });
                }}
                options={[...LENGTHS.map((l) => ({ value: l.id as string, label: l.label })), ...(lengthId === "custom" ? [{ value: "custom", label: "Custom" }] : [])]}
              />
              <div className="mt-2 flex items-center gap-2 text-xs text-muted">
                <input className="input w-16 px-2 py-1" type="number" min={5} max={180} value={s.minClipSeconds} onChange={(e) => patch({ minClipSeconds: Number(e.target.value) })} />
                to
                <input className="input w-16 px-2 py-1" type="number" min={10} max={300} value={s.maxClipSeconds} onChange={(e) => patch({ maxClipSeconds: Number(e.target.value) })} />
                seconds
              </div>
            </div>
            <div>
              <label className="label">How many</label>
              <div className="flex flex-wrap items-center gap-3">
                <Segmented
                  value={s.maxClips ? "cap" : "auto"}
                  onChange={(v) => patch({ maxClips: v === "auto" ? undefined : (s.maxClips ?? 10) })}
                  options={[
                    { value: "auto", label: "Every strong moment", title: "The AI returns as many clips as the video supports" },
                    { value: "cap", label: "At most…" },
                  ]}
                />
                {s.maxClips !== undefined && <input className="input w-20 px-2 py-1" type="number" min={1} max={50} value={s.maxClips} onChange={(e) => patch({ maxClips: Math.max(1, Number(e.target.value)) })} />}
              </div>
              <p className="mt-1 text-xs text-muted">No target count is given to the AI; weak moments are dropped instead of padding the list.</p>
            </div>
            <div>
              <label className="label">Find clips about (optional)</label>
              <input
                className="input"
                placeholder="e.g. pricing, the founding story, anything about sleep"
                value={s.focus ?? ""}
                onChange={(e) => patch({ focus: e.target.value || undefined })}
                maxLength={300}
              />
              <p className="mt-1 text-xs text-muted">Only on-topic moments are kept, and each clip gets a relevance score.</p>
            </div>
          </section>

          <section className="card p-4">
            <h2 className="mb-3 text-sm font-semibold">Captions & hook</h2>
            <StyleControls style={style} onChange={(p) => patch(p)} />
          </section>

          <section className="card p-4">
            <button type="button" className="flex w-full items-center justify-between text-sm font-semibold" onClick={() => setMore(!more)}>
              Transcript & AI
              <ChevronDown className={`h-4 w-4 transition ${more ? "rotate-180" : ""}`} />
            </button>
            {more && (
              <div className="mt-3 space-y-3">
                <div>
                  <label className="label">Names & terms to spell correctly</label>
                  <input
                    className="input"
                    placeholder="e.g. Copia, La Marzocco, Priyanka (also pulled from the title, description and tags)"
                    value={s.vocabulary ?? ""}
                    onChange={(e) => patch({ vocabulary: e.target.value || undefined })}
                  />
                </div>
                <div>
                  <label className="label">Extra instructions for the AI</label>
                  <textarea
                    className="input"
                    rows={2}
                    placeholder="e.g. Avoid clips with profanity. Prefer stories over tips."
                    value={s.instructions ?? ""}
                    onChange={(e) => patch({ instructions: e.target.value || undefined })}
                  />
                </div>
                <p className="text-xs text-muted">Fillers, repeats and false starts are removed from captions and cut from the video automatically. Review them on the transcript after processing.</p>
              </div>
            )}
          </section>

        </div>
      </div>

      {/* always reachable: sticks to the bottom of the scrolling page */}
      <div className="sticky bottom-0 z-10 -mx-4 mt-4 border-t border-border bg-bg/95 px-4 py-3 backdrop-blur">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0 text-xs text-muted">
            {error ? <span className="text-danger">{error}</span> : uploadPct !== null ? `Uploading… ${Math.round(uploadPct * 100)}%` : <span className="truncate">Model: {settingsQ.data?.aiModel} · Transcription: {settingsQ.data?.transcriptionModel}</span>}
          </div>
          <button className="btn-primary" disabled={busy}>
            {busy ? "Working…" : "Generate clips"}
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
