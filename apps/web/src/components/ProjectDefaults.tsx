import { Skeleton } from "./ui";
import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { UserProjectDefaults } from "@reelsaw/shared";
import { useTRPC } from "../lib/trpc";
import { toast } from "sonner";
import { useMe } from "../lib/account";
import { Link } from "react-router";
import { useBumperLibrary } from "./BumperField";

type Form = { language: string; vocabulary: string; instructions: string; focus: string; pauses: "off" | "natural" | "tight" | ""; sourceText: "hide" | "keep" | "always" | ""; minClipSeconds: string; maxClipSeconds: string; maxClips: string; highlightColor: string; wordsPerLine: string; uppercase: "" | "yes" | "no" };

const EMPTY: Form = { language: "", vocabulary: "", instructions: "", focus: "", pauses: "", sourceText: "", minClipSeconds: "", maxClipSeconds: "", maxClips: "", highlightColor: "", wordsPerLine: "", uppercase: "" };

function fromSaved(d: UserProjectDefaults): Form {
  return {
    ...EMPTY,
    language: d.language ?? "",
    vocabulary: d.vocabulary ?? "",
    instructions: d.instructions ?? "",
    focus: d.focus ?? "",
    pauses: d.pauses ?? "",
    sourceText: d.sourceText ?? "",
    minClipSeconds: d.minClipSeconds?.toString() ?? "",
    maxClipSeconds: d.maxClipSeconds?.toString() ?? "",
    maxClips: d.maxClips?.toString() ?? "",
    highlightColor: d.highlightColor ?? "",
    wordsPerLine: d.wordsPerLine?.toString() ?? "",
    uppercase: d.uppercase === undefined ? "" : d.uppercase ? "yes" : "no",
  };
}

function toSaved(f: Form): UserProjectDefaults {
  const num = (s: string) => (s.trim() === "" ? undefined : Number(s));
  return {
    language: f.language.trim() || undefined,
    vocabulary: f.vocabulary.trim() || undefined,
    instructions: f.instructions.trim() || undefined,
    focus: f.focus.trim() || undefined,
    pauses: f.pauses || undefined,
    sourceText: f.sourceText || undefined,
    minClipSeconds: num(f.minClipSeconds),
    maxClipSeconds: num(f.maxClipSeconds),
    maxClips: num(f.maxClips),
    highlightColor: f.highlightColor.trim() || undefined,
    wordsPerLine: num(f.wordsPerLine),
    uppercase: f.uppercase === "" ? undefined : f.uppercase === "yes",
  };
}

/**
 * Settings → Project defaults. Empty field = the built-in default (shown as the placeholder).
 * Applied to every new project; the new-project form starts from them and can still change each one.
 */
export function ProjectDefaultsSection() {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const me = useMe();
  const [f, setF] = useState<Form>(EMPTY);
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  useEffect(() => {
    if (me.data && loadedFor !== me.data.id) {
      setF(fromSaved(me.data.projectDefaults));
      setLoadedFor(me.data.id);
    }
  }, [me.data, loadedFor]);
  const save = useMutation({
    ...trpc.me.updateProjectDefaults.mutationOptions(),
    onSuccess: () => {
      toast("Defaults saved");
      void qc.invalidateQueries({ queryKey: trpc.me.pathKey() });
    },
    onError: (e) => toast.error(e.message),
  });
  const b = me.data?.builtInDefaults;
  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF((p) => ({ ...p, [k]: e.target.value }));
  const dirty = me.data ? JSON.stringify(toSaved(f)) !== JSON.stringify(toSaved(fromSaved(me.data.projectDefaults))) : false;

  return (
    <section className="flex flex-col gap-3 rounded-[16px] border border-line bg-panel p-5">
      <div>
        <h2 className="text-[15px] font-bold">Project defaults</h2>
        <p className="mt-1 text-[13px] text-ink2">Applied to every new project you start (and to agents creating projects with your key). Leave a field empty to keep the built-in default.</p>
      </div>
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(toSaved(f));
        }}
      >
        <label className="flex flex-col gap-1 text-xs text-ink2">
          Vocabulary (names, brands, jargon)
          <textarea className="input min-h-[64px]" value={f.vocabulary} onChange={set("vocabulary")} placeholder="Comma separated" maxLength={1000} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink2">
          Instructions for the model
          <textarea className="input min-h-[64px]" value={f.instructions} onChange={set("instructions")} placeholder="e.g. prefer practical tips over stories" maxLength={2000} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink2">
          Language
          <input className="input" value={f.language} onChange={set("language")} placeholder="auto-detect" maxLength={10} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink2">
          Focus topic
          <input className="input" value={f.focus} onChange={set("focus")} placeholder="any" maxLength={300} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink2">
          Pauses
          <select className="input" value={f.pauses} onChange={set("pauses")}>
            <option value="">{`built-in (${b?.pauses ?? "natural"})`}</option>
            <option value="natural">natural</option>
            <option value="tight">tight</option>
            <option value="off">keep as recorded</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink2">
          Text already in the video
          <select className="input" value={f.sourceText} onChange={set("sourceText")}>
            <option value="">{`built-in (${b?.sourceText ?? "hide"})`}</option>
            <option value="hide">hide, except in presentations</option>
            <option value="always">always hide</option>
            <option value="keep">keep</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink2">
          Shortest clip (s)
          <input className="input" type="number" min={5} max={180} value={f.minClipSeconds} onChange={set("minClipSeconds")} placeholder={String(b?.minClipSeconds ?? 20)} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink2">
          Longest clip (s)
          <input className="input" type="number" min={10} max={300} value={f.maxClipSeconds} onChange={set("maxClipSeconds")} placeholder={String(b?.maxClipSeconds ?? 60)} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink2">
          Most clips per project
          <input className="input" type="number" min={1} max={50} value={f.maxClips} onChange={set("maxClips")} placeholder="as many as stand on their own" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink2">
          Caption highlight colour
          <input className="input" value={f.highlightColor} onChange={set("highlightColor")} placeholder={b?.highlightColor ?? "#FFD700"} maxLength={7} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink2">
          Words per caption line
          <input className="input" type="number" min={1} max={8} value={f.wordsPerLine} onChange={set("wordsPerLine")} placeholder={String(b?.wordsPerLine ?? 4)} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink2">
          Uppercase captions
          <select className="input" value={f.uppercase} onChange={set("uppercase")}>
            <option value="">{`built-in (${b?.uppercase ? "yes" : "no"})`}</option>
            <option value="yes">yes</option>
            <option value="no">no</option>
          </select>
        </label>
        <div className="flex items-center gap-2 sm:col-span-2">
          <button className="btn-ink min-w-[8rem]" type="submit" disabled={!dirty || save.isPending}>
            {save.isPending ? "Saving…" : "Save defaults"}
          </button>
          <button className="btn-ghost" type="button" disabled={save.isPending} onClick={() => setF(EMPTY)}>
            Clear all
          </button>
          <span className="min-h-5 text-xs text-ink3">{dirty ? "Unsaved changes" : ""}</span>
        </div>
      </form>
      <BumperDefaultsRow introId={me.data?.projectDefaults.introAssetId} outroId={me.data?.projectDefaults.outroAssetId} />
    </section>
  );
}

/** Settings keeps only a summary; the library itself lives on /library. */
function BumperDefaultsRow({ introId, outroId }: { introId?: string; outroId?: string }) {
  const lib = useBumperLibrary();
  const name = (id?: string): ReactNode =>
    id ? (lib.data?.assets.find((a) => a.id === id)?.name ?? (lib.isPending ? <Skeleton className="inline-block h-3.5 w-24 align-middle" /> : "removed")) : "none";
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line pt-4">
      <div className="min-w-0 flex-1">
        <h3 className="text-[13px] font-bold">Intro and outro defaults</h3>
        <p className="mt-1 min-h-5 truncate text-[13px] text-ink2">
          Intro: <b className="font-semibold text-ink">{name(introId)}</b> · Outro: <b className="font-semibold text-ink">{name(outroId)}</b>
        </p>
      </div>
      <Link to="/library" className="text-[13px] font-semibold text-acc-text no-underline">
        Manage library →
      </Link>
    </div>
  );
}
