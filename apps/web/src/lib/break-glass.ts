/**
 * 13.2 — break-glass sign-in links in the web app. The command on the server prints `/#break_glass=<token>&email=…`:
 * the token is in the fragment, which a browser never sends to a server, a proxy log or a Referer, and opening the
 * page uses nothing. The confirm page sends the token once the person clicks.
 */

export interface BreakGlassLink {
  token: string;
  /** The admin the command named, for the confirm page only (the server decides who is signed in). */
  email: string | null;
}

/** The break-glass link in a page fragment, or null. */
export function breakGlassLinkFromHash(hash: string): BreakGlassLink | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const token = params.get("break_glass")?.trim();
  if (!token) return null;
  const email = params.get("email")?.trim();
  return { token, email: email || null };
}

/** The address without the break-glass fragment, or null when it has none. */
export function stripBreakGlassFragment(pathname: string, search: string, hash: string): string | null {
  const fragment = new URLSearchParams(hash.replace(/^#/, ""));
  if (!fragment.has("break_glass")) return null;
  fragment.delete("break_glass");
  fragment.delete("email");
  const h = fragment.toString();
  return `${pathname}${search}${h ? `#${h}` : ""}`;
}
