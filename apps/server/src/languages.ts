/**
 * The spoken languages a project can pick, each with what Reelsaw does less well for it than for English
 * (pipeline/language.ts `languageGaps`): "captions: no font on this server draws Devanagari", "filler and repeat
 * removal: English only". One service behind the language picker (`languages.list`), `list_languages` and
 * `reelsaw languages`, so a user or an admin sees a gap before anything renders.
 */
import { languageProfile } from "@reelsaw/shared";
import { loadFontState, missingGlyphs, systemGlyphs, uploadedGlyphs } from "./fonts.js";
import { spokenLanguages, type SpokenLanguages } from "./ai/spoken-languages.js";
import { languageGaps, type FontEnv, type StageCapability } from "./pipeline/language.js";
import type { Services } from "./services.js";

export interface LanguageWithGaps {
  code: string;
  name: string;
  /** the stages that do less for this language than for English; empty = everything works as for English */
  gaps: Array<Omit<StageCapability, "stage"> & { stage: string }>;
}

export interface LanguagesList extends Omit<SpokenLanguages, "languages"> {
  languages: LanguageWithGaps[];
}

type Deps = Pick<Services, "models" | "providers" | "config" | "log" | "database" | "paths" | "storage">;

/**
 * The fonts every caption can draw with on this server: installed ones, and the uploaded ones (by family). With
 * `only`, the uploaded fonts are read only when the installed ones miss letters of those languages, so one language's
 * check (transcribe) does not pull every uploaded font to the host.
 */
export async function languageFonts(svc: Pick<Services, "database" | "paths" | "storage" | "log">, only?: readonly string[]): Promise<FontEnv> {
  const system = await systemGlyphs();
  if (!system || only?.every((l) => !missingGlyphs(system, languageProfile(l).letters).length)) return { system };
  const state = await loadFontState(svc.database.db);
  return { system, uploaded: await uploadedGlyphs(svc, state.uploaded) };
}

export async function listLanguages(svc: Deps): Promise<LanguagesList> {
  const [spoken, fonts] = await Promise.all([spokenLanguages(svc), languageFonts(svc)]);
  return { ...spoken, languages: spoken.languages.map((l) => ({ ...l, gaps: languageGaps(l.code, fonts) })) };
}
