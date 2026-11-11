/**
 * 13.2 — the break-glass sign-in route and the per-request audit of break-glass sessions (break-glass-service.ts).
 *
 * A link minted on the host with `admin:break-glass` opens the studio with the token in its `#fragment`. The studio's
 * confirm page names the admin and, on a click, sends `POST /api/auth/break-glass` with `{ "token": "bg_…" }`. Nothing
 * here answers a GET, so a link preview, a mail scanner or a prefetch cannot use or test a link.
 *
 * The POST is refused before the link is touched when it comes from another site: an `Origin` must be one of
 * WEB_ORIGIN or APP_PUBLIC_URL, and without an `Origin` the browser's `Sec-Fetch-Site` must be `same-origin` or
 * `none` (or absent, for a non-browser client on the host). A JSON body also needs a CORS preflight cross-origin. The
 * network allowlists run before it like any other request.
 *
 * Every response to a request made with a break-glass session is audited as `auth.break_glass_request` (method,
 * route, status), not sampled.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "./config.js";
import type { AuditActor, AuditEventInput } from "./services/audit-service.js";
import { BREAK_GLASS_ROUTE, sessionReference, type BreakGlassService } from "./services/break-glass-service.js";
import type { LoginSession, SessionService } from "./services/session-service.js";

export interface BreakGlassRouteDeps {
  config: Pick<AppConfig, "WEB_ORIGIN" | "APP_PUBLIC_URL" | "SESSION_COOKIE_NAME" | "COOKIE_SECURE">;
  breakGlass: BreakGlassService;
  sessions: SessionService;
  /** The actor fields of a request (address honouring TRUST_PROXY, user agent). */
  requestActor: (request: FastifyRequest) => { ipAddress: string | null; userAgent: string | null };
  /** Records an audit event (audit table and log streams). */
  audit: (event: AuditEventInput) => Promise<void>;
}

/** The origins the studio is served from: every WEB_ORIGIN entry and APP_PUBLIC_URL's origin. */
export function breakGlassAllowedOrigins(config: Pick<AppConfig, "WEB_ORIGIN" | "APP_PUBLIC_URL">): Set<string> {
  const origins = new Set<string>();
  for (const entry of [...config.WEB_ORIGIN.split(","), config.APP_PUBLIC_URL]) {
    const value = entry.trim();
    if (!value) continue;
    try {
      origins.add(new URL(value).origin);
    } catch {
      // Not a URL: never matches.
    }
  }
  return origins;
}

function headerOf(request: FastifyRequest, name: string): string | null {
  const raw = request.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Why a confirm POST is refused as cross-site, or null when it may go on. */
export function crossSiteRefusal(request: FastifyRequest, allowed: Set<string>): string | null {
  const origin = headerOf(request, "origin");
  if (origin !== null) return allowed.has(origin) ? null : "origin";
  const site = headerOf(request, "sec-fetch-site");
  if (site !== null && site !== "same-origin" && site !== "none") return "sec-fetch-site";
  return null;
}

const GENERIC_REFUSAL = "This break-glass link is invalid, expired or already used. Run the break-glass command on the server again.";

export function registerBreakGlassRoutes(app: FastifyInstance, deps: BreakGlassRouteDeps): void {
  const cookieName = deps.config.SESSION_COOKIE_NAME;
  const allowedOrigins = breakGlassAllowedOrigins(deps.config);

  app.post<{ Body: unknown }>(BREAK_GLASS_ROUTE, async (request, reply) => {
    reply.header("cache-control", "no-store");
    const actor = deps.requestActor(request);
    const crossSite = crossSiteRefusal(request, allowedOrigins);
    if (crossSite) {
      // The link is not touched: a page on another site cannot sign this browser in or burn the link.
      await deps.audit({
        category: "auth",
        eventType: "auth.break_glass_used",
        action: "login",
        outcome: "denied",
        actor: { type: "system", ...actor },
        metadata: { reason: "cross_site", check: crossSite, origin: headerOf(request, "origin") }
      });
      request.log.warn({ check: crossSite }, "Break-glass sign-in refused: cross-site request");
      return reply.code(403).send({ error: "Break-glass sign-in must be confirmed from the studio page the link opens." });
    }
    const body = request.body && typeof request.body === "object" ? (request.body as Record<string, unknown>) : {};
    const token = typeof body.token === "string" ? body.token.trim() : "";
    const result = await deps.breakGlass.redeem(token, request, deps.sessions, actor);
    if (!result.ok) {
      request.log.warn({ reason: result.reason }, "Break-glass link refused");
      return reply.code(401).send({ error: GENERIC_REFUSAL });
    }
    request.log.warn({ userId: result.user.id, expiresAt: result.expiresAt }, "Break-glass session opened");
    // A session this browser held before is replaced, so it does not linger beside the break-glass one.
    const previous = request.cookies?.[cookieName];
    if (previous && previous !== result.sessionId) {
      await deps.sessions.endSession(previous, "logout").catch(() => false);
    }
    const maxAge = Math.max(1, Math.floor((new Date(result.expiresAt).getTime() - Date.now()) / 1000));
    reply.setCookie(cookieName, result.sessionId, {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      secure: deps.config.COOKIE_SECURE,
      maxAge
    });
    return { user: { id: result.user.id, email: result.user.email, role: result.user.role }, expiresAt: result.expiresAt };
  });

  /** The break-glass session a request was made with, from the auth context or the cookie (looked up once). */
  const breakGlassSessionOf = async (request: FastifyRequest): Promise<{ session: LoginSession; user: { id: string; email: string } | null } | null> => {
    const context = deps.sessions.getRequestAuth(request);
    if (context) {
      return context.credential === "session" && context.session.breakGlass ? { session: context.session, user: context.user } : null;
    }
    // Routes that check the cookie themselves (logout, a few admin checks) record no context; the cached row is used.
    const sessionId = request.cookies?.[cookieName];
    if (!sessionId || !request.url.startsWith("/api/")) return null;
    const session = await deps.sessions.getRequestSession(request, sessionId).catch(() => null);
    return session?.breakGlass ? { session, user: null } : null;
  };

  app.addHook("onResponse", async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.url.split("?")[0] === BREAK_GLASS_ROUTE) return;
    try {
      const found = await breakGlassSessionOf(request);
      if (!found) return;
      const actor: AuditActor = {
        type: "user",
        userId: found.user?.id ?? found.session.userId,
        email: found.user?.email ?? null,
        ...deps.requestActor(request)
      };
      await deps.audit({
        category: "auth",
        eventType: "auth.break_glass_request",
        action: "access",
        outcome: reply.statusCode >= 400 ? "failure" : "success",
        actor,
        metadata: {
          method: request.method,
          route: request.routeOptions?.url ?? null,
          path: (request.url.split("?")[0] ?? "").slice(0, 512),
          status: reply.statusCode,
          sessionRef: sessionReference(found.session.id)
        }
      });
    } catch (error) {
      request.log.warn({ error: error instanceof Error ? error.message : String(error) }, "Break-glass request audit not recorded");
    }
  });
}
