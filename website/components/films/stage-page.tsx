"use client";

import { FilmStage, FitBox } from "./core";
import { FILMS } from "./index";

/** The body of /films/<slug>: native size for capture, or a live scaled preview. */
export function FilmStagePage({ slug, preview }: { slug: string; preview: boolean }) {
  const film = FILMS[slug];
  if (!film) return null;
  if (preview) {
    return (
      <main style={{ minHeight: "100dvh", background: "#0f0f10", display: "grid", placeItems: "center", padding: 24, boxSizing: "border-box" }}>
        <div style={{ width: "100%", maxWidth: 1400, borderRadius: 12, overflow: "hidden", border: "1px solid #303034" }}>
          <FitBox W={film.W} H={film.H}>
            <FilmStage film={film} />
          </FitBox>
        </div>
      </main>
    );
  }
  return (
    <main style={{ width: film.W, height: film.H, overflow: "hidden", background: "#141416" }}>
      <FilmStage film={film} capture />
    </main>
  );
}
