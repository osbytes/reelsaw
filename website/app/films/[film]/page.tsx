import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { FILM_NAMES, type FilmName } from "@/components/films/names";
import { FilmStagePage } from "@/components/films/stage-page";

// A demo film at its native size for scripts/render-film.mjs (it drives time through window.__film
// and screenshots every frame). `?preview=1` plays it live, scaled to the window, for checking a
// film while writing it. Not for people: noindex, not in the sitemap.
export const metadata: Metadata = {
  title: "Demo film (render source)",
  robots: { index: false, follow: false },
};

export const dynamicParams = false;
export function generateStaticParams() {
  return FILM_NAMES.map((film) => ({ film }));
}

export default async function FilmPage({ params, searchParams }: { params: Promise<{ film: string }>; searchParams: Promise<{ preview?: string }> }) {
  const { film } = await params;
  if (!FILM_NAMES.includes(film as FilmName)) notFound();
  const { preview } = await searchParams;
  return <FilmStagePage slug={film} preview={Boolean(preview)} />;
}
