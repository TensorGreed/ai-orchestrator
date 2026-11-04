/**
 * Roadmap 7.3 — deployment-level user invites in the web app. An invite link opens `/#invite=<token>`; the login
 * page then shows the accept form instead of the sign-in form, and the token is dropped from the address bar at once.
 * The token is in the fragment, which a browser never sends to a server, so web-server and proxy access logs and
 * Referer headers never carry it. A link with `?invite=` (an older link) still works, but that form is logged by the
 * web server.
 */

/** The invite token in a page address (its fragment first, then its query), or null. */
export function inviteTokenFromLocation(search: string, hash: string): string | null {
  const fromHash = new URLSearchParams(hash.replace(/^#/, "")).get("invite");
  const token = fromHash && fromHash.trim() ? fromHash : new URLSearchParams(search).get("invite");
  return token && token.trim() ? token.trim() : null;
}

/** The address without the invite token, or null when it has none. */
export function stripInviteParam(pathname: string, search: string, hash: string): string | null {
  const query = new URLSearchParams(search);
  const fragment = new URLSearchParams(hash.replace(/^#/, ""));
  if (!query.has("invite") && !fragment.has("invite")) return null;
  query.delete("invite");
  fragment.delete("invite");
  const q = query.toString();
  const h = fragment.toString();
  return `${pathname}${q ? `?${q}` : ""}${h ? `#${h}` : ""}`;
}

export const INVITE_SIGNED_IN_NOTICE = "Sign out to accept this invite, then open the link again.";
