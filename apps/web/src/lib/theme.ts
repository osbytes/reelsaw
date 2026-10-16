import { useSyncExternalStore } from "react";

export type Theme = "light" | "dark";
const KEY = "rs-theme";

// one source of truth for every toggle (header, editor, ⌘K): <html data-theme>, remembered per browser
const listeners = new Set<() => void>();
const read = (): Theme => (document.documentElement.dataset.theme === "dark" ? "dark" : "light");

export function setTheme(t: Theme) {
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* private mode */
  }
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  // another tab changed it
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY && (e.newValue === "dark" || e.newValue === "light") && e.newValue !== read()) {
      document.documentElement.dataset.theme = e.newValue;
      l();
    }
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(l);
    window.removeEventListener("storage", onStorage);
  };
};

export function useTheme(): [Theme, () => void] {
  const theme = useSyncExternalStore(subscribe, read, () => "light" as Theme);
  return [theme, () => setTheme(read() === "dark" ? "light" : "dark")];
}
