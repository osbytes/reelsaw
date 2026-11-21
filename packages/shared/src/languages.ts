/**
 * Spoken languages: the codes a project's `language` setting takes. The set is Whisper's own
 * (openai/whisper `tokenizer.LANGUAGES`, which faster-whisper, Groq and the OpenAI API share), a
 * closed list fixed by the model, so it lives in code; names come from `Intl.DisplayNames`, never
 * from a list typed here. "jw" is Whisper's code for Javanese (ISO 639-1 "jv").
 */
// biome-ignore format: one code list, not one code per line
export const SPOKEN_LANGUAGES = [
  "en", "zh", "de", "es", "ru", "ko", "fr", "ja", "pt", "tr", "pl", "ca", "nl", "ar", "sv", "it", "id", "hi", "fi", "vi",
  "he", "uk", "el", "ms", "cs", "ro", "da", "hu", "ta", "no", "th", "ur", "hr", "bg", "lt", "la", "mi", "ml", "cy", "sk",
  "te", "fa", "lv", "bn", "sr", "az", "sl", "kn", "et", "mk", "br", "eu", "is", "hy", "ne", "mn", "bs", "kk", "sq", "sw",
  "gl", "mr", "pa", "si", "km", "sn", "yo", "so", "af", "oc", "ka", "be", "tg", "sd", "gu", "am", "yi", "lo", "uz", "fo",
  "ht", "ps", "tk", "nn", "mt", "sa", "lb", "my", "bo", "tl", "mg", "as", "tt", "haw", "ln", "ha", "ba", "jw", "su", "yue",
] as const;

export type SpokenLanguage = (typeof SPOKEN_LANGUAGES)[number];

const KNOWN = new Set<string>(SPOKEN_LANGUAGES);
/** Codes Whisper spells differently from BCP 47, for naming only. */
const BCP47: Record<string, string> = { jw: "jv" };
/** Other spellings people and models use for a code in the set ("iw" is the old code for Hebrew). */
const ALIASES: Record<string, string> = { jv: "jw", iw: "he", in: "id", ji: "yi", nb: "no", fil: "tl", cmn: "zh", zho: "zh" };

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
    return namer(locale)?.of(BCP47[code] ?? code) ?? code;
  } catch {
    return code; // not a well-formed tag
  }
}

let byName: Map<string, string> | undefined;
/** English names of the set, lower-cased ("german" → "de"), as some models report the language by name. */
function codeForName(name: string): string | undefined {
  byName ??= new Map(SPOKEN_LANGUAGES.map((c) => [languageLabel(c).toLowerCase(), c]));
  return byName.get(name);
}

/**
 * Normalise what a user, a subtitle file or a model calls a language to a code: "en", "en-US",
 * "English", "pt_BR" → "en" / "pt"; empty → undefined. A tag outside the set keeps its primary
 * subtag, so nothing a user typed is silently dropped.
 */
export function spokenLanguageCode(lang: string | null | undefined): string | undefined {
  const l = lang?.trim().toLowerCase();
  if (!l) return undefined;
  if (KNOWN.has(l)) return l;
  const named = codeForName(l);
  if (named) return named;
  const base = l.split(/[-_]/)[0]!;
  return ALIASES[base] ?? base;
}

/**
 * The set as picker options, sorted by name in `locale`. `native` is the language's name for itself
 * ("Deutsch"), when the runtime knows it and it differs, so a speaker finds their language either way.
 */
export function spokenLanguageOptions(locale = "en"): Array<{ value: SpokenLanguage; label: string; native?: string }> {
  return SPOKEN_LANGUAGES.map((value) => {
    const label = languageLabel(value, locale);
    const native = languageLabel(value, BCP47[value] ?? value);
    return native !== label && native !== value ? { value, label, native } : { value, label };
  }).sort((a, b) => a.label.localeCompare(b.label, locale));
}
