import { useEffect } from "react";

/**
 * "Clip title · Project · Reelsaw": the most specific name first, so a row of tabs (or the history menu) tells
 * pages apart. Empty parts (a name still loading) are skipped; with none left it is plain "Reelsaw".
 */
export function pageTitle(...parts: Array<string | null | undefined>): string {
  return [...parts.map((p) => p?.trim()).filter(Boolean), "Reelsaw"].join(" · ");
}

/** Every page sets its tab title (pageTitle); leaving the page puts back "Reelsaw" from index.html. */
export function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = title;
    return () => {
      document.title = "Reelsaw";
    };
  }, [title]);
}
