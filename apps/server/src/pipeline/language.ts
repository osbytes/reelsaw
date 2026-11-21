/**
 * What Reelsaw does right for a spoken language, stage by stage: one registry every stage asks, read from the
 * language's profile (@reelsaw/shared `languageProfile`: script, direction, case, spacing, punctuation and letters,
 * all from Unicode and CLDR data) and, for captions, from the fonts this server draws with. A stage that cannot do
 * its job for a language degrades the way its entry says and records why; none assumes Latin script and English
 * punctuation. `list_languages`, `reelsaw languages` and the language picker show the same gaps before anything
 * renders (languageGaps). test/language-matrix.test.ts sweeps every language the transcription model can take, so a
 * new language, font or stage is checked the day it lands.
 *
 * Several stages are English-only by construction (word lists, a consonant-skeleton sound-alike key, an English
 * acoustic model), and a wrong automatic edit is worse than a missed one, so they are skipped for any other language
 * instead of running silently and finding nothing (or the wrong thing). Add a language to them only together with
 * the data the stage needs for it.
 */
import { languageLabel, languageProfile, spokenLanguageCode, type LanguageProfile } from "@reelsaw/shared";
import { missingGlyphs, type Glyphs } from "../fonts.js";

export type LanguageStage =
  | "captionFont"
  | "rtlLayout"
  | "lineBreaking"
  | "hookCase"
  | "sentenceBoundaries"
  | "disfluencyRules"
  | "entityPhonetics"
  | "ctcAlign";

/** full: works as it does for English; limited: works, in the reduced way the message says; none: skipped. */
export type CapabilityLevel = "full" | "limited" | "none";

export interface StageCapability {
  stage: LanguageStage;
  /** what the stage is, in the words the UI uses ("captions") */
  label: string;
  level: CapabilityLevel;
  /** what happens for this language, as a sentence a user understands */
  message: string;
}

/** What the caption check needs from the host: the installed fonts' glyphs (null = could not be read) and the uploaded fonts'. */
export interface FontEnv {
  system: Glyphs | null;
  uploaded?: Array<{ family: string; glyphs: Glyphs }>;
}

/** The stages that exist for some languages only, and those languages. Closed: our own stages and their data. */
const ONLY_FOR: Partial<Record<LanguageStage, readonly string[]>> = { disfluencyRules: ["en"], entityPhonetics: ["en"], ctcAlign: ["en"] };

export function scriptName(p: LanguageProfile): string {
  if (!p.script) return "its script";
  try {
    return new Intl.DisplayNames(["en"], { type: "script" }).of(p.script) ?? p.script;
  } catch {
    return p.script;
  }
}
const quote = (cs: string[], n = 8) => cs.slice(0, n).join(" ") + (cs.length > n ? " …" : "");

type Check = (p: LanguageProfile, name: string, fonts: FontEnv | undefined) => Omit<StageCapability, "stage" | "label">;

/** Which caption fonts draw `text`: what is missing from the installed fonts, and the uploaded fonts that have it. */
export function glyphGap(text: string, fonts: FontEnv): { missing: string[]; uploadedCover: string[] } {
  const missing = fonts.system ? missingGlyphs(fonts.system, text) : [];
  const uploadedCover = missing.length ? (fonts.uploaded ?? []).filter((u) => missingGlyphs(u.glyphs, missing.join("")).length === 0).map((u) => u.family) : [];
  return { missing, uploadedCover };
}

const STAGES: Record<LanguageStage, { label: string; check: Check }> = {
  captionFont: {
    label: "captions",
    check: (p, _name, fonts) => {
      if (!fonts) return { level: "full", message: "fonts not checked" };
      // no fontconfig (a dev machine): unknown, not a gap, as the render treats it (render.ts fontGapEvent)
      if (!fonts.system) return { level: "full", message: "fonts not checked: this server could not list them (fontconfig)" };
      const letters = p.letters || p.sample;
      const { missing, uploadedCover } = glyphGap(letters, fonts);
      if (!missing.length) return { level: "full", message: `drawn with the installed fonts (${scriptName(p)})` };
      const pick = uploadedCover.length ? `; the uploaded font ${uploadedCover.map((f) => `"${f}"`).join(" or ")} has them: pick it as the caption font` : "";
      return missing.length / new Set(letters).size > 0.5
        ? { level: "none", message: `no font on this server draws ${scriptName(p)}, so captions would show empty boxes${pick}` }
        : { level: "limited", message: `${missing.length} letters have no font on this server and would show as empty boxes (${quote(missing)})${pick}` };
    },
  },
  rtlLayout: {
    label: "caption direction",
    check: (p) => ({ level: "full", message: p.direction === "rtl" ? "lines are laid out right to left" : "lines are laid out left to right" }),
  },
  lineBreaking: {
    label: "caption lines",
    check: (p) =>
      p.spaced
        ? { level: "full", message: "lines break between words" }
        : { level: "full", message: `${scriptName(p)} is written without spaces: words join without them, and lines break by the width of the text` },
  },
  hookCase: {
    label: "hooks",
    check: (p, name) =>
      p.cased
        ? { level: "full", message: `upper-cased the way ${name} writes capitals` }
        : { level: "limited", message: `shown as written: ${scriptName(p)} has no capital letters` },
  },
  sentenceBoundaries: {
    label: "clip edges",
    check: (p) =>
      p.terminals
        ? { level: "full", message: `start and end on sentences (${[...p.terminals].join(" ")}), or on pauses when the transcript has no punctuation` }
        : { level: "limited", message: "start and end on pauses in speech: no sentence punctuation is known for this language" },
  },
  disfluencyRules: { label: "filler and repeat removal", check: onlyFor("disfluencyRules") },
  entityPhonetics: { label: "name fixes", check: onlyFor("entityPhonetics") },
  ctcAlign: { label: "word timing at cuts", check: onlyFor("ctcAlign") },
};

function onlyFor(stage: LanguageStage): Check {
  const codes = ONLY_FOR[stage]!;
  return (p, name) =>
    codes.includes(p.code)
      ? { level: "full", message: "available" }
      : { level: "none", message: `not available for ${name} yet: it works for ${codes.map((c) => languageLabel(c)).join(", ")} only` };
}

export const LANGUAGE_STAGES = Object.keys(STAGES) as LanguageStage[];

/** "en", "en-US", "English" → "en"; empty → undefined. The one normaliser, shared with the web app. */
export function languageCode(lang: string | null | undefined): string | undefined {
  return spokenLanguageCode(lang);
}

/**
 * What `stage` does for `lang`. Undefined (not detected) is assumed English, which is what every stage was built
 * for. Captions are checked against the fonts only when `fonts` is given (languageFonts).
 */
export function capability(stage: LanguageStage, lang: string | null | undefined, fonts?: FontEnv): StageCapability {
  const p = languageProfile(languageCode(lang) ?? "en");
  return { stage, label: STAGES[stage].label, ...STAGES[stage].check(p, languageLabel(p.code), fonts) };
}

/** Every stage's answer for `lang`, in pipeline order. */
export function capabilities(lang: string | null | undefined, fonts?: FontEnv): StageCapability[] {
  return LANGUAGE_STAGES.map((s) => capability(s, lang, fonts));
}

/** The stages that do less for `lang` than for English: what every surface lists next to a language. */
export function languageGaps(lang: string | null | undefined, fonts?: FontEnv): StageCapability[] {
  return capabilities(lang, fonts).filter((c) => c.level !== "full");
}

/** The stage runs for the language at all (the English-only stages are skipped where this is false). */
export function supports(stage: LanguageStage, lang: string | null | undefined): boolean {
  return capability(stage, lang).level !== "none";
}

/** A gap as the line every surface shows: "captions: no font on this server draws Devanagari, …". */
export const gapLine = (c: Pick<StageCapability, "label" | "message">) => `${c.label}: ${c.message}`;

/**
 * Whisper's own spelling of a canonical code, for Whisper models only: its table predates the
 * standard "jv" for Javanese, and it has one code where people also use another (Norwegian "no" for
 * Bokmål "nb", Tagalog "tl" for Filipino "fil"). Closed: fixed by Whisper's table (whisper-languages.ts).
 */
const WHISPER_SPELLING: Record<string, string> = { jv: "jw", nb: "no", fil: "tl" };

/**
 * The provider options that tell a transcription model which language is spoken, under the
 * `providerOptions` key it reads (AiService.transcriptionOptionsKey). Without them every model
 * auto-detects, and a wrong guess on the first seconds (music, a greeting in another language)
 * transcribes or even translates the whole chunk in the wrong language. Unset = detect.
 */
export function transcriptionLanguageOptions(provider: string, lang: string | null | undefined, modelId = ""): Record<string, unknown> {
  const code = languageCode(lang);
  if (!code) return {};
  switch (provider) {
    case "openai": // also the OpenAI-compatible provider (Speaches, whisper.cpp servers): ai/compat-transcription.ts forwards it
    case "groq":
      // the "openai" key also carries gpt-4o-transcribe and non-Whisper servers, which take the standard code
      return { language: /whisper/i.test(modelId) ? (WHISPER_SPELLING[code] ?? code) : code };
    case "deepgram":
      return { language: code };
    case "assemblyai":
      return { languageCode: code };
    default:
      return {};
  }
}

/** "de" → "German"; undefined when unset. */
export function languageName(lang: string | null | undefined): string | undefined {
  const code = languageCode(lang);
  return code ? languageLabel(code) : undefined;
}

/**
 * The prompt line that makes a model write the viewer-facing text (titles, hooks, captions, hashtags)
 * in the video's language: the prompts are English, and without it a Spanish video comes back with
 * English packaging. Empty for English and for an undetected language, so those prompts stay as they were.
 */
export function outputLanguageRule(lang: string | null | undefined, fields: string): string {
  const code = outputLanguage(lang);
  if (!code) return "";
  // the user's own instructions win: "write the titles in English" for a German video is a choice, not a mistake
  return `- The video is in ${languageName(code)}. Write ${fields} in ${languageName(code)}, whatever language these instructions are in, unless the user's instructions ask for another language.
`;
}

/**
 * The language a prompt names for the viewer-facing text, as a code: undefined for English and for an undetected
 * language, whose prompts (and so step keys) stay as they were before the rule existed. Step inputs carry this,
 * never the raw transcript language, so an English project's saved steps keep their keys.
 */
export function outputLanguage(lang: string | null | undefined): string | undefined {
  const code = languageCode(lang);
  return code && code !== "en" ? code : undefined;
}

/** Reason recorded when a stage is skipped for the transcript's language: the registry's own sentence. */
export function skipReason(stage: LanguageStage, lang: string | null | undefined): string {
  return capability(stage, lang).message;
}
