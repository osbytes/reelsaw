import { captionsFilm } from "./captions";
import type { FilmDef } from "./core";
import { heroFilm } from "./hero";
import { localFilm } from "./local";
import { reframeFilm } from "./reframe";

/** Every demo film, by slug (keep components/films/names.ts in step). /films/<slug> renders one for capture; public/films/<slug>.* is the output. */
export const FILMS: Record<string, FilmDef> = {
  [heroFilm.name]: heroFilm,
  [captionsFilm.name]: captionsFilm,
  [reframeFilm.name]: reframeFilm,
  [localFilm.name]: localFilm,
};
