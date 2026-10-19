"use client";

import { Moon, Sun } from "lucide-react";
import { useSyncExternalStore } from "react";

export type Theme = "light" | "dark";
export const THEME_KEY = "rs-theme";

// Same contract as the app (apps/web/src/lib/theme.ts): <html data-theme>, remembered per browser.
const listeners = new Set<() => void>();
const read = (): Theme => (document.documentElement.dataset.theme === "dark" ? "dark" : "light");

function setTheme(t: Theme) {
  document.documentElement.dataset.theme = t;
  try {
    localStorage.setItem(THEME_KEY, t);
  } catch {
    /* private mode */
  }
  for (const l of listeners) l();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  const onStorage = (e: StorageEvent) => {
    if (e.key === THEME_KEY && (e.newValue === "dark" || e.newValue === "light") && e.newValue !== read()) {
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

export function useTheme(): [Theme | null, () => void] {
  // null on the server and until hydration, so the icon never claims a theme it does not know
  const theme = useSyncExternalStore(subscribe, read, () => null);
  return [theme, () => setTheme(read() === "dark" ? "light" : "dark")];
}

/** Runs before first paint so the page never flashes the wrong theme. Inlined in <head>. */
export const THEME_BOOT_SCRIPT = `try{var t=localStorage.getItem(${JSON.stringify(THEME_KEY)})||(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light");document.documentElement.dataset.theme=t}catch(e){}`;

export function ThemeToggle({ className = "" }: { className?: string }) {
  const [theme, toggle] = useTheme();
  return (
    <button type="button" className={`btn-ghost h-[34px] w-[34px] px-0 ${className}`} onClick={toggle} title={theme === "dark" ? "Light theme" : "Dark theme"} aria-label="Toggle theme">
      {/* fixed-size slot: the icon swaps after hydration without moving anything */}
      <span className="grid h-4 w-4 place-items-center">{theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className={`h-4 w-4 ${theme ? "" : "opacity-0"}`} />}</span>
    </button>
  );
}
