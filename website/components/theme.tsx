"use client";

import { Moon, Sun } from "lucide-react";
import { useLayoutEffect, useSyncExternalStore } from "react";
import { THEME_KEY } from "@/lib/theme-script";

export type Theme = "light" | "dark";
export { THEME_KEY };

// Same contract as the app (apps/web/src/lib/theme.ts): <html data-theme>, remembered per browser.
const listeners = new Set<() => void>();
const read = (): Theme => (document.documentElement.dataset.theme === "dark" ? "dark" : "light");

function preferred(): Theme {
  try {
    const t = localStorage.getItem(THEME_KEY);
    if (t === "dark" || t === "light") return t;
  } catch {
    /* private mode */
  }
  try {
    return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  } catch {
    return "light";
  }
}

/** Re-apply the remembered theme. React can clear data-theme while rebuilding <html>. */
function applyStoredTheme() {
  const t = preferred();
  if (document.documentElement.dataset.theme === t) return;
  document.documentElement.dataset.theme = t;
  for (const l of listeners) l();
}

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
  // The boot script restored the attribute after this render read it.
  const onSync = () => l();
  window.addEventListener("storage", onStorage);
  window.addEventListener("rs-theme", onSync);
  return () => {
    listeners.delete(l);
    window.removeEventListener("storage", onStorage);
    window.removeEventListener("rs-theme", onSync);
  };
};

export function useTheme(): [Theme | null, () => void] {
  // null on the server and until hydration, so the icon never claims a theme it does not know
  const theme = useSyncExternalStore(subscribe, read, () => null);
  return [theme, () => setTheme(read() === "dark" ? "light" : "dark")];
}

/** Mount once under <body>. Runs after React strips data-theme and before paint. */
export function ThemeSync() {
  useLayoutEffect(() => {
    applyStoredTheme();
  }, []);
  return null;
}

export function ThemeToggle({ className = "" }: { className?: string }) {
  const [theme, toggle] = useTheme();
  return (
    <button
      type="button"
      className={`btn-ghost h-[34px] w-[34px] px-0 ${className}`}
      onClick={toggle}
      title={theme === "dark" ? "Light theme" : "Dark theme"}
      aria-label="Toggle theme"
    >
      {/* fixed-size slot: the icon swaps after hydration without moving anything */}
      <span className="grid h-4 w-4 place-items-center">
        {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className={`h-4 w-4 ${theme ? "" : "opacity-0"}`} />}
      </span>
    </button>
  );
}
