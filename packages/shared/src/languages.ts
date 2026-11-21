/**
 * Spoken languages: the codes a project's `language` setting takes. Codes are BCP 47 primary language
 * subtags ("en", "jv", "yue"), canonicalised by `Intl.Locale` from CLDR's alias data ("iw" → "he",
 * "jw" → "jv", "deu" → "de"), so no alias table is typed here. Names come from `Intl.DisplayNames`.
 *
 * Which languages a project can pick is the transcription model's to say (the server's
 * `list_languages`, apps/server/src/ai/spoken-languages.ts); WHISPER_SPOKEN_LANGUAGES is what is
 * assumed when the model does not say, generated from Whisper's own table (whisper-languages.ts).
 */
import { WHISPER_LANGUAGES } from "./whisper-languages.js";

/** "iw" → "he", "jw" → "jv", "zho" → "zh", "pt_BR" → "pt"; undefined for something that is not a language tag. */
export function canonicalLanguage(tag: string): string | undefined {
  try {
    return new Intl.Locale(tag.trim().replace(/_/g, "-")).language;
  } catch {
    return undefined;
  }
}

/** Whisper's languages as canonical codes, in Whisper's order. */
export const WHISPER_SPOKEN_LANGUAGES: readonly string[] = [...new Set(WHISPER_LANGUAGES.map((c) => canonicalLanguage(c) ?? c))];

const displayNames = new Map<string, Intl.DisplayNames | null>();
function namer(locale: string): Intl.DisplayNames | null {
  if (!displayNames.has(locale)) {
    try {
      displayNames.set(locale, new Intl.DisplayNames([locale], { type: "language", fallback: "none" }));
    } catch {
      displayNames.set(locale, null);
    }
  }
  return displayNames.get(locale) ?? null;
}

/** "de" → "German" (or "Deutsch" with locale "de"); the code itself when the runtime has no name for it. */
export function languageLabel(code: string, locale = "en"): string {
  try {
    return namer(locale)?.of(code) ?? code;
  } catch {
    return code; // not a well-formed tag
  }
}

let byName: Map<string, string> | undefined;
/** English names, lower-cased ("german" → "de"), as some models and people give the language by name. */
function codeForName(name: string): string | undefined {
  byName ??= new Map(WHISPER_SPOKEN_LANGUAGES.map((c) => [languageLabel(c).toLowerCase(), c]));
  return byName.get(name);
}

/**
 * Normalise what a user, a subtitle file or a model calls a language to a canonical code: "en",
 * "en-US", "English", "pt_BR", "jw" → "en" / "pt" / "jv"; empty → undefined. A code outside any
 * model's list keeps its canonical form. Anything else ("Englsh") is undefined, so detection runs
 * instead of a model being sent a language it cannot know.
 */
export function spokenLanguageCode(lang: string | null | undefined): string | undefined {
  const l = lang?.trim().toLowerCase();
  if (!l) return undefined;
  // a name ("german") is also a well-formed 5-8 letter tag, so names are tried first, and only
  // ISO 639's 2- and 3-letter codes are taken as tags
  const code = codeForName(l) ?? canonicalLanguage(l);
  return code && code.length <= 3 ? code : undefined;
}

/**
 * `codes` as picker options, sorted by name in `locale`. `native` is the language's name for itself
 * ("Deutsch"), when the runtime knows it and it differs, so a speaker finds their language either way.
 */
export function spokenLanguageOptions(
  codes: readonly string[] = WHISPER_SPOKEN_LANGUAGES,
  locale = "en",
): Array<{ value: string; label: string; native?: string }> {
  return codes
    .map((value) => {
      const label = languageLabel(value, locale);
      const native = languageLabel(value, value);
      return native !== label && native !== value ? { value, label, native } : { value, label };
    })
    .sort((a, b) => a.label.localeCompare(b.label, locale));
}
