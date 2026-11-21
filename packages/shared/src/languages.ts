/**
 * Spoken languages: the codes a project's `language` setting takes. Codes are BCP 47 primary language
 * subtags ("en", "jv", "yue"), canonicalised by `Intl.Locale` from CLDR's alias data ("iw" → "he",
 * "jw" → "jv", "deu" → "de"), so no alias table is typed here. Names come from `Intl.DisplayNames`.
 *
 * Which languages a project can pick is the transcription model's to say (the server's
 * `list_languages`, apps/server/src/ai/spoken-languages.ts); WHISPER_SPOKEN_LANGUAGES is what is
 * assumed when the model does not say, generated from Whisper's own table (whisper-languages.ts).
 */
import { WHISPER_LANGUAGE_NAMES, WHISPER_LANGUAGES } from "./whisper-languages.js";

/** "iw" → "he", "jw" → "jv", "zho" → "zh", "pt_BR" → "pt"; undefined for something that is not a language tag. */
export function canonicalLanguage(tag: string): string | undefined {
  try {
    return new Intl.Locale(tag.trim().replace(/_/g, "-")).language;
  } catch {
    return undefined;
  }
}

/**
 * ISO 639's codes that name no language: "und" (undetermined), "mul" (multiple), "mis" (uncoded), "zxx" (no
 * linguistic content) and the private-use range qaa-qtz. Closed: fixed by the standard.
 */
const NOT_A_LANGUAGE = /^(und|mul|mis|zxx|q[a-t][a-z])$/;

/** A canonical code that names one spoken language: ISO 639's 2- and 3-letter codes, without the special ones. */
export function spokenCanonical(tag: string): string | undefined {
  const c = canonicalLanguage(tag);
  return c && c.length <= 3 && !NOT_A_LANGUAGE.test(c) ? c : undefined;
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
/**
 * English names, lower-cased, as some models (OpenAI's whisper-1) and people give the language by name: Whisper's
 * own names first ("bengali", "myanmar", "mandarin"), which differ from the standard ones for a few languages,
 * then the names `Intl` gives ("bangla", "burmese").
 */
function codeForName(name: string): string | undefined {
  if (!byName) {
    byName = new Map(WHISPER_SPOKEN_LANGUAGES.map((c) => [languageLabel(c).toLowerCase(), c]));
    for (const [n, c] of Object.entries(WHISPER_LANGUAGE_NAMES)) byName.set(n, canonicalLanguage(c) ?? c);
  }
  return byName.get(name);
}

/**
 * Normalise what a user, a subtitle file or a model calls a language to a canonical code: "en",
 * "en-US", "English", "pt_BR", "jw" → "en" / "pt" / "jv"; empty → undefined. A code outside any
 * model's list keeps its canonical form. Anything else ("Englsh", "und", "mul") is undefined, so
 * detection runs instead of a model being sent a language it cannot know.
 */
export function spokenLanguageCode(lang: string | null | undefined): string | undefined {
  const l = lang?.trim().toLowerCase();
  if (!l) return undefined;
  // a name ("german") is also a well-formed 5-8 letter tag, so names are tried first
  return codeForName(l) ?? spokenCanonical(l);
}

/**
 * A settings object with its `language` as a canonical code, or without it when the value names no language
 * ("Englsh"), so what every surface stores is a code the model can take or nothing (detect). The one place
 * settings are normalised: project create and update, and the saved project defaults.
 */
export function withSpokenLanguage<T extends { language?: string | null | undefined }>(settings: T): T {
  if (settings.language === undefined) return settings;
  const { language, ...rest } = settings;
  const code = spokenLanguageCode(language);
  return (code ? { ...rest, language: code } : rest) as T;
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
      // a runtime without the language's own data names it in its default locale instead: no native name then
      const native = Intl.DisplayNames.supportedLocalesOf([value]).length ? languageLabel(value, value) : value;
      return native !== label && native !== value ? { value, label, native } : { value, label };
    })
    .sort((a, b) => a.label.localeCompare(b.label, locale));
}
