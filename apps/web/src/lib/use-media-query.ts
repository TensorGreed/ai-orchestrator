import { useEffect, useState } from "react";

/**
 * Viewport width at and below which the app shell switches to its phone layout: the sidebar
 * becomes an off-canvas drawer and secondary HUD pills move into the command palette.
 * Matches the `@media (max-width: 880px)` page breakpoint in pages.css and shell.css.
 */
export const SHELL_DRAWER_MEDIA_QUERY = "(max-width: 880px)";

function readMatch(query: string): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia(query).matches;
  } catch {
    return false;
  }
}

/** Live `matchMedia` result for `query`; false where matchMedia is unavailable. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => readMatch(query));

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    if (typeof list.addEventListener === "function") {
      list.addEventListener("change", update);
      return () => list.removeEventListener("change", update);
    }
    list.addListener?.(update);
    return () => list.removeListener?.(update);
  }, [query]);

  return matches;
}
