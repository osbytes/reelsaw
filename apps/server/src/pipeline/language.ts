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

/**
 * The provider options that tell a transcription model which language is spoken, under the
 * `providerOptions` key it reads (AiService.transcriptionOptionsKey). Without them every model
 * auto-detects, and a wrong guess on the first seconds (music, a greeting in another language)
 * transcribes or even translates the whole chunk in the wrong language. Unset = detect.
 */
export function transcriptionLanguageOptions(provider: string, lang: string | null | undefined): Record<string, unknown> {
  const code = languageCode(lang);
  if (!code) return {};
  switch (provider) {
    case "openai": // also the OpenAI-compatible provider (Speaches, whisper.cpp servers): ai/compat-transcription.ts forwards it
    case "groq":
    case "deepgram":
      return { language: code };
    case "assemblyai":
      return { languageCode: code };
    default:
      return {};
  }
}

/** "de" → "German"; the code itself when the runtime has no name for it, undefined when unset. */
export function languageName(lang: string | null | undefined): string | undefined {
  const code = languageCode(lang);
  if (!code) return undefined;
  try {
    return new Intl.DisplayNames(["en"], { type: "language", fallback: "none" }).of(code) ?? code;
  } catch {
    return code; // not a well-formed tag
  }
}

/**
 * The prompt line that makes a model write the viewer-facing text (titles, hooks, captions, hashtags)
 * in the video's language: the prompts are English, and without it a Spanish video comes back with
 * English packaging. Empty for English and for an undetected language, so those prompts stay as they were.
 */
export function outputLanguageRule(lang: string | null | undefined, fields: string): string {
  const code = languageCode(lang);
  if (!code || code === "en") return "";
  return `- The video is in ${languageName(code)}. Write ${fields} in ${languageName(code)}, whatever language these instructions are in.
`;
}

/** Reason recorded when a stage is skipped for the transcript's language. */
export function skipReason(lang: string | null | undefined): string {
  return `not available for ${languageCode(lang) ?? "this language"}`;
}
