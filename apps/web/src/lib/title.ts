import { useEffect } from "react";

/** Public pages set a specific tab title; everything else stays "Reelsaw" from index.html. */
export function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = title;
    return () => {
      document.title = "Reelsaw";
    };
  }, [title]);
}
