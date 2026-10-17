import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Trash2, Upload } from "lucide-react";
import { useTRPC } from "../lib/trpc";
import { useToast } from "../lib/toast";
import { uploadFile } from "../lib/uploads";

const MAX_BYTES = 50 * 1024 * 1024;
const ACCEPT = ".mp4,.mov,.webm,video/mp4,video/quicktime,video/webm";

/** One intro or outro: upload, a 9:16 preview with its length, Remove. Saved as soon as it is uploaded. */
function BumperField({ slot, assetId }: { slot: "intro" | "outro"; assetId: string | undefined }) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const [pct, setPct] = useState<number | null>(null);
  const [error, setError] = useState("");
  const list = useQuery(trpc.bumpers.list.queryOptions());
  const asset = assetId ? list.data?.find((a) => a.id === assetId) : undefined;
  const create = useMutation(trpc.bumpers.create.mutationOptions());
  const remove = useMutation(trpc.bumpers.delete.mutationOptions());
  const label = slot === "intro" ? "Intro" : "Outro";
  const busy = pct !== null || create.isPending || remove.isPending;

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: trpc.me.pathKey() });
    void qc.invalidateQueries({ queryKey: trpc.bumpers.pathKey() });
  };
  const pick = async (file: File | undefined) => {
    if (!file) return;
    setError("");
    if (file.size > MAX_BYTES) return setError(`This file is ${Math.ceil(file.size / 1024 / 1024)} MB. ${label}s can be at most 50 MB.`);
    try {
      setPct(0);
      const uploadId = await uploadFile(file, setPct);
      await create.mutateAsync({ uploadId, slot });
      refresh();
      toast(`${label} saved`);
    } catch (e) {
      setError((e as Error).message.slice(0, 200));
    } finally {
      setPct(null);
      if (input.current) input.current.value = "";
    }
  };
  const ratioOff = asset ? Math.abs(asset.width / asset.height - 9 / 16) > 0.02 : false;

  return (
    <div className="flex gap-3">
      {/* fixed 9:16 box: nothing moves when the file arrives */}
      <button
        type="button"
        className="relative aspect-[9/16] w-[72px] shrink-0 overflow-hidden rounded-[10px] border border-dashed border-line bg-sunk disabled:cursor-default"
        disabled={!asset}
        aria-label={asset ? `Play ${slot} preview` : `No ${slot} set`}
        onClick={() => {
          const v = video.current;
          if (!v) return;
          if (v.paused) {
            v.muted = false;
            void v.play();
          } else v.pause();
        }}
      >
        {asset && <video ref={video} key={asset.id} src={`/media/bumpers/${asset.id}#t=0.1`} preload="metadata" playsInline className="h-full w-full object-cover" onEnded={(e) => (e.currentTarget.currentTime = 0.1)} />}
      </button>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <b className="text-[13px]">{label}</b>
        <div className="min-h-[2.5rem] text-xs text-ink2">
          {asset ? (
            <>
              <div className="truncate">{asset.name}</div>
              <div className="font-mono text-ink3">
                {asset.durationSec.toFixed(1)} s{asset.hasAudio ? "" : " · silent"}
              </div>
              {ratioOff && <div className="text-ink3">Fitted to vertical with a blurred background.</div>}
            </>
          ) : (
            <span className="text-ink3">None. MP4, MOV or WebM, up to 10 s and 50 MB.</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <input ref={input} type="file" accept={ACCEPT} className="hidden" onChange={(e) => void pick(e.target.files?.[0])} aria-label={`Choose ${slot} video`} />
          <button type="button" className="btn-ghost min-w-[7.5rem]" disabled={busy} onClick={() => input.current?.click()}>
            {pct !== null ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
            {pct !== null ? `${Math.round(pct * 100)}%` : asset ? "Replace" : "Upload"}
          </button>
          <button
            type="button"
            className="btn-quiet"
            disabled={busy || !asset}
            aria-label={`Remove ${slot}`}
            title={`Remove ${slot}`}
            onClick={() => assetId && remove.mutate({ id: assetId }, { onSuccess: () => (refresh(), toast(`${label} removed`)), onError: (e) => setError(e.message) })}
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-4 text-xs text-err" role="status">
          {error}
        </div>
      </div>
    </div>
  );
}

/** Settings → Intro and outro: attached to every clip of the projects you start from now on. */
export function BumpersSection({ introId, outroId }: { introId?: string; outroId?: string }) {
  return (
    <div className="flex flex-col gap-3 border-t border-line pt-4">
      <div>
        <h3 className="text-[13px] font-bold">Intro and outro</h3>
        <p className="mt-1 text-[13px] text-ink2">A short video of yours added to the start and end of every clip. Applies to new projects only.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <BumperField slot="intro" assetId={introId} />
        <BumperField slot="outro" assetId={outroId} />
      </div>
    </div>
  );
}
