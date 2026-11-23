import { Select, Skeleton } from "./ui";
import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { BUMPER_TRANSITIONS, FADE_PRESETS, formatNumber, type BumperTransition, type UserProjectDefaults } from "@reelsaw/shared";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { useTRPC } from "../lib/trpc";
import { toast } from "sonner";
import { useMe } from "../lib/account";
import { Link } from "react-router";
import { useBumperLibrary } from "./BumperField";
import { RefineDefaultsFields } from "./RefineToggles";
import { TemplateSelect } from "./TemplatePicker";
import { LanguageCombobox } from "./LanguageCombobox";
import { fontOptions, useFonts } from "../lib/fonts";

type RefineForm = { refineEntities: "" | "yes" | "no"; refineDisfluency: "" | "yes" | "no"; disfluencyLlm: "" | "yes" | "no"; refineScenes: "" | "yes" | "no" };
type Form = {
  language: string;
  vocabulary: string;
  instructions: string;
  focus: string;
  pauses: "off" | "natural" | "tight" | "";
  sourceText: "hide" | "keep" | "always" | "";
  minClipSeconds: string;
  maxClipSeconds: string;
  maxClips: string;
  highlightColor: string;
  font: string;
  wordsPerLine: string;
  uppercase: "" | "yes" | "no";
  fadeIn: string;
  fadeOut: string;
  bumperTransition: BumperTransition | "";
  bumperTransitionSec: string;
  layerTemplateId: string;
} & RefineForm;

const EMPTY: Form = {
  language: "",
  vocabulary: "",
  instructions: "",
  focus: "",
  pauses: "",
  sourceText: "",
  minClipSeconds: "",
  maxClipSeconds: "",
  maxClips: "",
  highlightColor: "",
  font: "",
  wordsPerLine: "",
  uppercase: "",
  fadeIn: "",
  fadeOut: "",
  bumperTransition: "",
  bumperTransitionSec: "",
  layerTemplateId: "",
  refineEntities: "",
  refineDisfluency: "",
  disfluencyLlm: "",
  refineScenes: "",
};

const yn = (v: boolean | undefined): "" | "yes" | "no" => (v === undefined ? "" : v ? "yes" : "no");
const fromYn = (v: "" | "yes" | "no") => (v === "" ? undefined : v === "yes");

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
    font: d.font ?? "",
    wordsPerLine: d.wordsPerLine?.toString() ?? "",
    uppercase: d.uppercase === undefined ? "" : d.uppercase ? "yes" : "no",
    fadeIn: d.fadeIn?.toString() ?? "",
    fadeOut: d.fadeOut?.toString() ?? "",
    bumperTransition: d.bumperTransition ?? "",
    bumperTransitionSec: d.bumperTransitionSec?.toString() ?? "",
    layerTemplateId: d.layerTemplateId ?? "",
    refineEntities: yn(d.refineEntities),
    refineDisfluency: yn(d.refineDisfluency),
    disfluencyLlm: yn(d.disfluencyLlm),
    refineScenes: yn(d.refineScenes),
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
    font: f.font || undefined,
    wordsPerLine: num(f.wordsPerLine),
    uppercase: f.uppercase === "" ? undefined : f.uppercase === "yes",
    fadeIn: num(f.fadeIn),
    fadeOut: num(f.fadeOut),
    bumperTransition: f.bumperTransition || undefined,
    bumperTransitionSec: num(f.bumperTransitionSec),
    layerTemplateId: f.layerTemplateId || undefined,
    refineEntities: fromYn(f.refineEntities),
    refineDisfluency: fromYn(f.refineDisfluency),
    disfluencyLlm: fromYn(f.disfluencyLlm),
    refineScenes: fromYn(f.refineScenes),
  };
}

/** Lower-case option names, as they read inside "built-in (…)" and the lists below. */
const PAUSES: Record<"natural" | "tight" | "off", MessageDescriptor> = { natural: msg`natural`, tight: msg`tight`, off: msg`keep as recorded` };
const SOURCE_TEXT: Record<"hide" | "always" | "keep", MessageDescriptor> = {
  hide: msg`hide, except in presentations`,
  always: msg`always hide`,
  keep: msg`keep`,
};
/** The saved values themselves, as "built-in (…)" names them. */
const PAUSES_VALUE: Record<"natural" | "tight" | "off", MessageDescriptor> = { natural: msg`natural`, tight: msg`tight`, off: msg`off` };
const SOURCE_TEXT_VALUE: Record<"hide" | "always" | "keep", MessageDescriptor> = { hide: msg`hide`, always: msg`always`, keep: msg`keep` };
/** BUMPER_TRANSITION_LABEL in @reelsaw/shared, lower-cased. */
const TRANSITION: Record<BumperTransition, MessageDescriptor> = { cut: msg`cut`, dip: msg`dip to black`, crossfade: msg`crossfade` };
/** FADE_PRESETS labels in @reelsaw/shared, lower-cased. */
const FADE_OFF = msg`off`;
const FADE: Record<string, MessageDescriptor> = { Off: msg`off`, Quick: msg`quick`, Smooth: msg`smooth`, Slow: msg`slow` };

/**
 * Settings → Project defaults. Empty field = the built-in default (shown as the placeholder).
 * Applied to every new project; the new-project form starts from them and can still change each one.
 */
export function ProjectDefaultsSection() {
  const { t } = useLingui();
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
      toast(t`Defaults saved`);
      void qc.invalidateQueries({ queryKey: trpc.me.pathKey() });
    },
    onError: (e) => toast.error(e.message),
  });
  const b = me.data?.builtInDefaults;
  const fonts = useFonts();
  const pick = (k: keyof Form) => (v: string) => setF((p) => ({ ...p, [k]: v }));
  const set = (k: keyof Form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setF((p) => ({ ...p, [k]: e.target.value }));
  const dirty = me.data ? JSON.stringify(toSaved(f)) !== JSON.stringify(toSaved(fromSaved(me.data.projectDefaults))) : false;
  const builtIn = (what: string) => t`built-in (${what})`;
  const seconds = (sec: number) => {
    const n = formatNumber(sec);
    return t`${n} s`;
  };
  const fadeWord = (sec: number) => (sec > 0 ? seconds(Number(sec.toFixed(2))) : t(FADE_OFF));
  const defaultFamily = fonts.defaultFamily;

  return (
    <section className="flex flex-col gap-3 rounded-[16px] border border-line bg-panel p-5">
      <div>
        <h2 className="text-[15px] font-bold">
          <Trans>Project defaults</Trans>
        </h2>
        <p className="mt-1 text-[13px] text-ink2">
          <Trans>
            Applied to every new project you start (and to agents creating projects with your key). Leave a field empty to keep the built-in default.
          </Trans>
        </p>
      </div>
      <form
        className="grid gap-3 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(toSaved(f));
        }}
      >
        <label className="flex flex-col gap-1 text-xs text-ink2">
          <Trans>Vocabulary (names, brands, jargon)</Trans>
          <textarea className="input min-h-[64px]" value={f.vocabulary} onChange={set("vocabulary")} placeholder={t`Comma separated`} maxLength={1000} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink2">
          <Trans>Instructions for the model</Trans>
          <textarea
            className="input min-h-[64px]"
            value={f.instructions}
            onChange={set("instructions")}
            placeholder={t`e.g. prefer practical tips over stories`}
            maxLength={2000}
          />
        </label>
        <div className="flex flex-col gap-1 text-xs text-ink2">
          <Trans>Spoken language</Trans>
          <LanguageCombobox value={f.language} onValueChange={(v) => pick("language")(v ?? "")} />
        </div>
        <label className="flex flex-col gap-1 text-xs text-ink2">
          <Trans>Focus topic</Trans>
          <input className="input" value={f.focus} onChange={set("focus")} placeholder={t`any`} maxLength={300} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink2">
          <Trans>Pauses</Trans>
          <Select
            ariaLabel={t`Pauses`}
            value={f.pauses}
            onValueChange={pick("pauses")}
            options={[
              { value: "", label: builtIn(t(PAUSES_VALUE[b?.pauses ?? "natural"])) },
              { value: "natural", label: t(PAUSES.natural) },
              { value: "tight", label: t(PAUSES.tight) },
              { value: "off", label: t(PAUSES.off) },
            ]}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink2">
          <Trans>Text already in the video</Trans>
          <Select
            ariaLabel={t`Text already in the video`}
            value={f.sourceText}
            onValueChange={pick("sourceText")}
            options={[
              { value: "", label: builtIn(t(SOURCE_TEXT_VALUE[b?.sourceText ?? "hide"])) },
              { value: "hide", label: t(SOURCE_TEXT.hide) },
              { value: "always", label: t(SOURCE_TEXT.always) },
              { value: "keep", label: t(SOURCE_TEXT.keep) },
            ]}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink2">
          <Trans>Shortest clip (s)</Trans>
          <input
            className="input"
            type="number"
            min={5}
            max={180}
            value={f.minClipSeconds}
            onChange={set("minClipSeconds")}
            placeholder={String(b?.minClipSeconds ?? 20)}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink2">
          <Trans>Longest clip (s)</Trans>
          <input
            className="input"
            type="number"
            min={10}
            max={300}
            value={f.maxClipSeconds}
            onChange={set("maxClipSeconds")}
            placeholder={String(b?.maxClipSeconds ?? 60)}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink2">
          <Trans>Most clips per project</Trans>
          <input
            className="input"
            type="number"
            min={1}
            max={50}
            value={f.maxClips}
            onChange={set("maxClips")}
            placeholder={t`as many as stand on their own`}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink2">
          <Trans>Caption font</Trans>
          <Select
            ariaLabel={t`Caption font`}
            value={f.font}
            onValueChange={pick("font")}
            options={[{ value: "", label: t`instance default (${defaultFamily})` }, ...fontOptions(fonts.fonts)]}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink2">
          <Trans>Caption highlight colour</Trans>
          <input className="input" value={f.highlightColor} onChange={set("highlightColor")} placeholder={b?.highlightColor ?? "#FFD700"} maxLength={7} />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink2">
          <Trans>Words per caption line</Trans>
          <input
            className="input"
            type="number"
            min={1}
            max={8}
            value={f.wordsPerLine}
            onChange={set("wordsPerLine")}
            placeholder={String(b?.wordsPerLine ?? 4)}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink2">
          <Trans>Uppercase captions</Trans>
          <Select
            ariaLabel={t`Uppercase captions`}
            value={f.uppercase}
            onValueChange={pick("uppercase")}
            options={[
              { value: "", label: builtIn(b?.uppercase ? t`yes` : t`no`) },
              { value: "yes", label: t`yes` },
              { value: "no", label: t`no` },
            ]}
          />
        </label>
        {(
          [
            ["fadeIn", msg`Fade in from black`],
            ["fadeOut", msg`Fade out to black`],
          ] as const
        ).map(([k, labelMsg]) => {
          const label = t(labelMsg);
          return (
            <label key={k} className="flex flex-col gap-1 text-xs text-ink2">
              {label}
              <Select
                ariaLabel={label}
                value={f[k]}
                onValueChange={pick(k)}
                options={[
                  { value: "", label: builtIn(fadeWord(b?.[k] ?? 0)) },
                  ...FADE_PRESETS.map((p) => {
                    const fade = FADE[p.label];
                    const name = fade ? t(fade) : p.label;
                    const len = seconds(p.sec);
                    return { value: String(p.sec), label: p.sec ? t`${name} (${len})` : name };
                  }),
                ]}
              />
            </label>
          );
        })}
        <label className="flex flex-col gap-1 text-xs text-ink2">
          <Trans>Intro and outro join</Trans>
          <Select
            ariaLabel={t`Intro and outro join`}
            value={f.bumperTransition}
            onValueChange={pick("bumperTransition")}
            options={[
              { value: "", label: builtIn(t(TRANSITION[b?.bumperTransition ?? "cut"])) },
              ...BUMPER_TRANSITIONS.map((tr) => ({ value: tr, label: t(TRANSITION[tr]) })),
            ]}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-ink2">
          <Trans>Join length</Trans>
          <Select
            ariaLabel={t`Join length`}
            value={f.bumperTransitionSec}
            onValueChange={pick("bumperTransitionSec")}
            options={[
              { value: "", label: builtIn(seconds(b?.bumperTransitionSec ?? 0.5)) },
              ...[0.3, 0.6, 1].map((sec) => ({ value: String(sec), label: seconds(sec) })),
            ]}
          />
        </label>
        <RefineDefaultsFields
          value={{
            refineEntities: fromYn(f.refineEntities),
            refineDisfluency: fromYn(f.refineDisfluency),
            disfluencyLlm: fromYn(f.disfluencyLlm),
            refineScenes: fromYn(f.refineScenes),
          }}
          builtIn={b}
          onChange={(key, v) => setF((p) => ({ ...p, [key]: yn(v) }))}
        />
        <div className="flex flex-col gap-1 text-xs text-ink2 sm:col-span-2">
          <span>
            <Trans>Layer template</Trans>
          </span>
          <div className="sm:max-w-[calc(50%-0.375rem)]">
            <TemplateSelect value={f.layerTemplateId} onChange={pick("layerTemplateId")} />
          </div>
          <span className="text-xs text-ink3">
            <Trans>Applies to the clips of new projects. Existing clips: select them in a project and choose Template…</Trans>
          </span>
        </div>
        <div className="flex items-center gap-2 sm:col-span-2">
          <button className="btn-ink min-w-[8rem]" type="submit" disabled={!dirty || save.isPending}>
            {save.isPending ? <Trans>Saving…</Trans> : <Trans>Save defaults</Trans>}
          </button>
          <button className="btn-ghost" type="button" disabled={save.isPending} onClick={() => setF(EMPTY)}>
            <Trans>Clear all</Trans>
          </button>
          <span className="min-h-5 text-xs text-ink3">{dirty ? <Trans>Unsaved changes</Trans> : ""}</span>
        </div>
      </form>
      <BumperDefaultsRow introId={me.data?.projectDefaults.introAssetId} outroId={me.data?.projectDefaults.outroAssetId} />
    </section>
  );
}

/** Settings keeps only a summary; the library itself lives on /library. */
function BumperDefaultsRow({ introId, outroId }: { introId?: string | undefined; outroId?: string | undefined }) {
  const { t } = useLingui();
  const lib = useBumperLibrary();
  const name = (id?: string): ReactNode =>
    id
      ? (lib.data?.assets.find((a) => a.id === id)?.name ?? (lib.isPending ? <Skeleton className="inline-block h-3.5 w-24 align-middle" /> : t`deleted`))
      : t`none`;
  const intro = name(introId);
  const outro = name(outroId);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t border-line pt-4">
      <div className="min-w-0 flex-1">
        <h3 className="text-[13px] font-bold">
          <Trans>Intro and outro defaults</Trans>
        </h3>
        <p className="mt-1 min-h-5 truncate text-[13px] text-ink2">
          <Trans>
            Intro: <b className="font-semibold text-ink">{intro}</b> · Outro: <b className="font-semibold text-ink">{outro}</b>
          </Trans>
        </p>
      </div>
      <Link to="/library" className="text-[13px] font-semibold text-acc-text no-underline">
        <Trans>Manage library →</Trans>
      </Link>
    </div>
  );
}
