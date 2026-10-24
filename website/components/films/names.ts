/** Slugs of every demo film (server-safe: the film modules themselves are client components). */
export const FILM_NAMES = ["hero", "captions", "reframe", "local"] as const;
export type FilmName = (typeof FILM_NAMES)[number];
