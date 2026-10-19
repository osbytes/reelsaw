import type { Metadata } from "next";
import { PipelineFilm } from "@/components/pipeline-film";

// The pipeline film at its native 1920×1080 with the clock off, for scripts/render-pipeline-film.mjs
// (it drives time through window.__pipelineFilm and screenshots every frame). Not for people:
// noindex, not in the sitemap.
export const metadata: Metadata = {
  title: "Pipeline film (render source)",
  robots: { index: false, follow: false },
};

export default function PipelineFilmPage() {
  return (
    <main style={{ width: 1920, height: 1080, overflow: "hidden", background: "#141416" }}>
      <PipelineFilm capture />
    </main>
  );
}
