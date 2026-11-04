/**
 * Roadmap 7.3 — deployment-level user invites in the web app. An invite link opens `/?invite=<token>`; the login
 * page then shows the accept form instead of the sign-in form, and the token is dropped from the address bar at once
 * (so it is not left in the history or sent on as a referrer).
 */

/** The invite token in a page address, or null. */
export function inviteTokenFromSearch(search: string): string | null {
  const token = new URLSearchParams(search).get("invite");
  return token && token.trim() ? token.trim() : null;
}

/** The address without `invite`, or null when it has none. */
export function stripInviteParam(pathname: string, search: string, hash: string): string | null {
  const params = new URLSearchParams(search);
  if (!params.has("invite")) return null;
  params.delete("invite");
  const query = params.toString();
  return `${pathname}${query ? `?${query}` : ""}${hash}`;
}
