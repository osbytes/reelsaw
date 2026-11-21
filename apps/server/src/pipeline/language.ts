/**
 * Which pipeline stages work for which spoken language. Several stages are English-only by
 * construction (word lists, a consonant-skeleton sound-alike key, an English acoustic model), and a
 * wrong automatic edit is worse than a missed one, so they are skipped for any other language
 * instead of running silently and finding nothing (or the wrong thing). Add a language here only
 * together with the data the stage needs for it.
 */
import { languageLabel, spokenLanguageCode } from "@reelsaw/shared";

export type LanguageStage = "disfluencyRules" | "entityPhonetics" | "ctcAlign";

const SUPPORTED: Record<LanguageStage, readonly string[]> = {
  disfluencyRules: ["en"],
  entityPhonetics: ["en"],
  ctcAlign: ["en"],
};

/** "en", "en-US", "English" → "en"; empty → undefined. The one normaliser, shared with the web app. */
export function languageCode(lang: string | null | undefined): string | undefined {
  return spokenLanguageCode(lang);
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

/** Reason recorded when a stage is skipped for the transcript's language. */
export function skipReason(lang: string | null | undefined): string {
  return `not available for ${languageCode(lang) ?? "this language"}`;
}
