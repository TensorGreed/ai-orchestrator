/**
 * 13.2 — the red banner of a break-glass session (a one-time sign-in link minted on the server host). It asks
 * /api/auth/me once and shows nothing for any other session.
 */
import { useEffect, useState } from "react";
import { fetchAuthMe } from "../lib/api";

/** The banner's text for a session ending at `expiresAt` (HH:MM in the viewer's time zone). */
export function breakGlassBannerText(expiresAt: string, locale?: string): string {
  const ends = new Date(expiresAt);
  const time = Number.isNaN(ends.getTime()) ? "within the hour" : `at ${ends.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })}`;
  return `Break-glass session. Every action is recorded. It ends ${time}.`;
}

export function BreakGlassBanner() {
  const [endsAt, setEndsAt] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchAuthMe()
      // `session` names the request's session (cookie sign-ins only; null for an API key).
      .then((me) => {
        if (!cancelled && me.session?.breakGlass) setEndsAt(me.session.expiresAt);
      })
      .catch(() => {
        // Not signed in any more: the app shows the login page; nothing to flag here.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!endsAt) return null;
  return (
    <div className="break-glass-banner" role="alert">
      {breakGlassBannerText(endsAt)}
    </div>
  );
}
