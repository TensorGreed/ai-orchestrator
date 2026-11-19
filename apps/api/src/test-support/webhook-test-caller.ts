/**
 * /webhook-test/ answers only a signed-in person (or an API key) who may edit the workflow. Tests that call it sign in a
 * test admin once per app and send that session's cookie.
 */
import type { FastifyInstance } from "fastify";
import type { AuthService } from "../services/auth-service.js";

interface CallerContext {
  app: FastifyInstance;
  authService: AuthService;
  config: { SESSION_COOKIE_NAME: string };
}

const cookies = new WeakMap<FastifyInstance, Promise<string>>();

/** The session cookie of a test admin on this app (registered and signed in on first use). */
export function webhookTestCookie(context: CallerContext): Promise<string> {
  let cookie = cookies.get(context.app);
  if (!cookie) {
    cookie = (async () => {
      const email = `webhook-tester-${Math.random().toString(36).slice(2, 10)}@example.com`;
      const password = "Webhook-Tester-123!";
      await context.authService.register({ email, password, role: "admin" });
      const response = await context.app.inject({ method: "POST", url: "/api/auth/login", payload: { email, password } });
      const raw = response.headers["set-cookie"];
      const values = Array.isArray(raw) ? raw : [raw ?? ""];
      const found = values.find((value) => value.startsWith(`${context.config.SESSION_COOKIE_NAME}=`));
      if (!found) throw new Error(`The webhook tester could not sign in: ${response.statusCode} ${response.body}`);
      return found.split(";")[0]!;
    })();
    cookies.set(context.app, cookie);
  }
  return cookie;
}
