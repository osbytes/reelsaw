/**
 * Which pipeline stages work for which spoken language. Several stages are English-only by
 * construction (word lists, a consonant-skeleton sound-alike key, an English acoustic model), and a
 * wrong automatic edit is worse than a missed one, so they are skipped for any other language
 * instead of running silently and finding nothing (or the wrong thing). Add a language here only
 * together with the data the stage needs for it.
 */
export type LanguageStage = "disfluencyRules" | "entityPhonetics" | "ctcAlign";

const SUPPORTED: Record<LanguageStage, readonly string[]> = {
  disfluencyRules: ["en"],
  entityPhonetics: ["en"],
  ctcAlign: ["en"],
};

const NAMES: Record<string, string> = {
  english: "en",
  german: "de",
  french: "fr",
  spanish: "es",
  italian: "it",
  portuguese: "pt",
  dutch: "nl",
  russian: "ru",
  japanese: "ja",
  chinese: "zh",
  korean: "ko",
  arabic: "ar",
  hindi: "hi",
  turkish: "tr",
  polish: "pl",
  ukrainian: "uk",
  swedish: "sv",
  indonesian: "id",
  vietnamese: "vi",
};

/** "en", "en-US", "English" → "en"; empty/unknown → undefined. */
export function languageCode(lang: string | null | undefined): string | undefined {
  const l = lang?.trim().toLowerCase();
  if (!l) return undefined;
  return NAMES[l] ?? l.split(/[-_]/)[0];
}

/** Undefined (not detected) is assumed English, which is what every stage was built for. */
export function supports(stage: LanguageStage, lang: string | null | undefined): boolean {
  const code = languageCode(lang);
  return code === undefined || SUPPORTED[stage].includes(code);
}

/** Reason recorded when a stage is skipped for the transcript's language. */
export function skipReason(lang: string | null | undefined): string {
  return `not available for ${languageCode(lang) ?? "this language"}`;
}
