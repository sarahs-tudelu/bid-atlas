import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";

const STORAGE_KEY = "bidatlas.theme";

function currentTheme(): Theme {
  if (typeof document === "undefined") return "light";
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

/**
 * Reads the theme the pre-paint bootstrap in index.html already resolved, and
 * keeps following the OS until the reader makes an explicit choice.
 */
export function useTheme(): { theme: Theme; toggleTheme: () => void } {
  const [theme, setTheme] = useState<Theme>(currentTheme);

  useEffect(() => {
    // Absent in jsdom and older browsers; the explicit toggle still works without it.
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const sync = () => {
      try {
        if (window.localStorage.getItem(STORAGE_KEY)) return;
      } catch {
        return;
      }
      const next: Theme = query.matches ? "dark" : "light";
      document.documentElement.dataset.theme = next;
      setTheme(next);
    };
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme((previous) => {
      const next: Theme = previous === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      try {
        window.localStorage.setItem(STORAGE_KEY, next);
      } catch {
        // A blocked storage quota should never stop the theme from flipping.
      }
      return next;
    });
  }, []);

  return { theme, toggleTheme };
}
