/**
 * 13.2 — break-glass sign-in end to end: the admin:break-glass command (in another connection, and as a real
 * process on SQLite) mints a link whose token is in the `#fragment`; the studio's confirm POST turns it into a
 * one-hour session. A GET (a link preview) uses nothing, a cross-site POST is refused, every request in the session
 * is audited (even with AUDIT_LOG_ENABLED=false), the alerts fire at issue, use and end, the network allowlists
 * still apply, and on Postgres a link confirmed on two instances at once works once.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FastifyInstance, InjectOptions } from "fastify";
import { createApp } from "./app.js";
import { parseConfig, type AppConfig } from "./config.js";
import type { Store } from "./db/store.js";
import { API_ROOT, runAdminBreakGlassCli } from "./scripts/admin-break-glass.js";
import { AppLifecycle } from "./services/app-lifecycle.js";
import { AuthService } from "./services/auth-service.js";
import { NotificationService, type NotificationEvent, type NotifyResult } from "./services/notification-service.js";
import { SecretService } from "./services/secret-service.js";
import {
  createTestStore,
  noticePostgresSkipped,
  openTestStore,
  openTestStoreTwin,
  testPostgresUrl,
  testStoreKind,
  type TestStore
} from "./test-support/test-store.js";
import { testSql } from "./test-support/test-sql.js";

const STUDIO_ORIGIN = "http://localhost:5173";
const COOKIE = "ao_session";

interface Booted {
  app: FastifyInstance;
  store: Store;
  file: string;
  dir: string;
  masterKey: string;
  config: AppConfig;
  env: Record<string, string>;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function boot(extraEnv: Record<string, string> = {}): Promise<Booted> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-break-glass-"));
  const file = path.join(dir, "orchestrator.db");
  const store = await openTestStore(file);
  await store.ensureDefaultProject();
  const masterKey = crypto.randomBytes(32).toString("base64");
  const env = {
    LOG_LEVEL: "fatal",
    SEED_SAMPLE_WORKFLOWS: "false",
    SECRET_MASTER_KEY_BASE64: masterKey,
    COOKIE_SECURE: "false",
    RATE_LIMIT_ENABLED: "false",
    MCP_PROBE_INTERVAL_MS: "0",
    GIT_SYNC_WORKDIR: path.join(dir, "sync"),
    ...extraEnv
  };
  const config = parseConfig(env);
  const app = await createApp(config, store, new SecretService(store, masterKey), new AuthService(store, config.SESSION_TTL_HOURS));
  await app.ready();
  cleanups.push(async () => {
    await app.close();
    try {
      await store.close();
    } catch {
      // Already closed by the app.
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { app, store, file, dir, masterKey, config, env };
}

/** Runs the command in-process against its own connection to the same database (another "process" for the store). */
async function mint(
  booted: Booted,
  args: string[],
  notify?: (event: NotificationEvent) => Promise<NotifyResult>
): Promise<{ code: number; out: string[]; err: string[]; link?: string; token?: string }> {
  const cliStore = await openTestStore(booted.file);
  const out: string[] = [];
  const err: string[] = [];
  try {
    const code = await runAdminBreakGlassCli(args, {
      apiRoot: booted.dir,
      env: { ...booted.env, DB_SQLITE_PATH: booted.file },
      store: cliStore,
      ...(notify ? { notify } : {}),
      io: { out: (line) => out.push(line), err: (line) => err.push(line) }
    });
    const link = linkIn(out.join("\n"));
    return { code, out, err, ...(link ? { link, token: tokenOf(link) } : {}) };
  } finally {
    await cliStore.close();
  }
}

function linkIn(output: string): string | undefined {
  return output.split("\n").map((line) => line.trim()).find((line) => line.includes("#break_glass="));
}

function tokenOf(link: string): string {
  return new URLSearchParams(new URL(link).hash.slice(1)).get("break_glass")!;
}

/** The studio's confirm POST (same origin unless headers say otherwise). */
function confirm(app: FastifyInstance, token: string, headers: Record<string, string> = { origin: STUDIO_ORIGIN, "sec-fetch-site": "same-origin" }, extra: Partial<InjectOptions> = {}) {
  return app.inject({ method: "POST", url: "/api/auth/break-glass", headers: { "content-type": "application/json", ...headers }, payload: { token }, ...extra } as InjectOptions);
}

function sessionCookie(header: string | string[] | number | undefined): string | undefined {
  const all = Array.isArray(header) ? header : typeof header === "string" ? [header] : [];
  return all.find((value) => value.startsWith(`${COOKIE}=`));
}

function sessionIdOf(response: { headers: Record<string, unknown> }): string {
  return sessionCookie(response.headers["set-cookie"] as string[] | string | undefined)!.split(";")[0]!.slice(`${COOKIE}=`.length);
}

async function auditRows(store: Store, eventType: string) {
  return (await store.listAuditLogs({ eventType, pageSize: 200 })).items;
}

async function registerAdmin(store: Store, email = "root@example.com") {
  return await new AuthService(store, 24).register({ email, password: "Root-Pass-123!", role: "admin" });
}

function stagesOf(spy: { mock: { calls: unknown[][] } }): Array<string | undefined> {
  return spy.mock.calls.map(([event]) => event as NotificationEvent).filter((event) => event.type === "auth.break_glass_used").map((event) => event.auth?.stage);
}

describe("break-glass sign-in through the app", () => {
  it("command to link to a confirmed one-hour session; single use; every request audited; alerts at issue, use and end", async () => {
    const booted = await boot({ APP_PUBLIC_URL: "https://l2m.example.com" });
    const notify = vi.spyOn(NotificationService.prototype, "notifyWithResults");
    const user = await registerAdmin(booted.store);

    const minted = await mint(booted, ["--", "--email", "root@example.com", "--minutes", "10"]);
    expect(minted.code, minted.err.join("\n")).toBe(0);
    expect(minted.link).toMatch(/^https:\/\/l2m\.example\.com\/#break_glass=bg_[A-Za-z0-9_-]{43}&email=root%40example\.com$/);
    // No channel is set up: the command says nobody was alerted, and still prints the link.
    expect(minted.err.join("\n")).toMatch(/No notification channel receives auth\.break_glass_used: nobody was alerted/);
    expect(await auditRows(booted.store, "auth.break_glass_issued")).toEqual([
      expect.objectContaining({ outcome: "success", actorType: "system", resourceId: user.id })
    ]);

    const opened = await confirm(booted.app, minted.token!, { origin: STUDIO_ORIGIN, "sec-fetch-site": "same-origin", "user-agent": "Rescue/1.0" });
    expect(opened.statusCode, opened.body).toBe(200);
    expect(opened.json()).toEqual({ user: { id: user.id, email: "root@example.com", role: "admin" }, expiresAt: expect.any(String) });
    expect(opened.headers["cache-control"]).toBe("no-store");
    expect(sessionCookie(opened.headers["set-cookie"])).toMatch(/Max-Age=(3599|3600)/);
    const sessionId = sessionIdOf(opened);
    const session = (await booted.store.getSession(sessionId))!;
    expect(session).toMatchObject({ userId: user.id, authMethod: "break_glass", breakGlass: true, userAgent: "Rescue/1.0" });
    expect(Math.abs(new Date(session.expiresAt).getTime() - new Date(session.createdAt).getTime() - 3_600_000)).toBeLessThan(5_000);

    const me = await booted.app.inject({ method: "GET", url: "/api/auth/me", cookies: { [COOKIE]: sessionId } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ user: { id: user.id, role: "admin" }, session: { breakGlass: true, expiresAt: session.expiresAt } });
    expect((await booted.app.inject({ method: "GET", url: "/api/workflows", cookies: { [COOKIE]: sessionId } })).statusCode).toBe(200);
    expect((await booted.app.inject({ method: "GET", url: "/api/does-not-exist", cookies: { [COOKIE]: sessionId } })).statusCode).toBe(404);

    // Used once.
    const again = await confirm(booted.app, minted.token!);
    expect(again.statusCode).toBe(401);
    expect(again.json()).toEqual({ error: expect.stringMatching(/invalid, expired or already used/) });
    expect(sessionCookie(again.headers["set-cookie"])).toBeUndefined();

    const logout = await booted.app.inject({ method: "POST", url: "/api/auth/logout", cookies: { [COOKIE]: sessionId } });
    expect(logout.statusCode).toBe(200);

    // onResponse hooks finish after inject resolves: wait for the last request's row.
    await vi.waitFor(async () => expect(await auditRows(booted.store, "auth.break_glass_request")).toHaveLength(4));
    const requests = await auditRows(booted.store, "auth.break_glass_request");
    expect(requests.map((row) => [(row.metadata as { route: string }).route, (row.metadata as { status: number }).status]).sort()).toEqual(
      [
        ["/api/auth/logout", 200],
        ["/api/auth/me", 200],
        ["/api/workflows", 200],
        [null, 404]
      ].sort()
    );
    expect(requests.every((row) => row.actorUserId === user.id)).toBe(true);
    expect(await auditRows(booted.store, "auth.break_glass_used")).toEqual(
      expect.arrayContaining([expect.objectContaining({ outcome: "success" }), expect.objectContaining({ outcome: "failure" })])
    );
    expect(await auditRows(booted.store, "auth.break_glass_ended")).toHaveLength(1);
    // Nothing recorded carries the link's token or the session id.
    const everything = JSON.stringify((await booted.store.listAuditLogs({ pageSize: 500 })).items);
    expect(everything).not.toContain(minted.token!);
    expect(everything).not.toContain(sessionId);

    // The command builds its own NotificationService (same prototype), so the issued alert is counted here too; the
    // used and ended alerts go out in the background.
    await vi.waitFor(() => expect(stagesOf(notify)).toEqual(["issued", "used", "ended"]));
  });

  it("a GET (a link preview, a mail scanner) uses nothing; a cross-site POST is refused and leaves the link usable", async () => {
    const booted = await boot();
    await registerAdmin(booted.store);
    const minted = await mint(booted, ["--email", "root@example.com"]);
    const token = minted.token!;
    // What a scanner can fetch: the studio page (served by the web server, not the API) and the API route by GET.
    for (const url of ["/", `/#break_glass=${token}`, "/api/auth/break-glass", `/api/auth/break-glass?token=${token}`, `/api/auth/break-glass/${token}`]) {
      const response = await booted.app.inject({ method: "GET", url });
      expect(response.statusCode, url).toBe(404);
      expect(sessionCookie(response.headers["set-cookie"])).toBeUndefined();
    }
    const crossSite: Array<Record<string, string>> = [
      { origin: "https://evil.example" },
      { origin: "null" },
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site" },
      { origin: "https://evil.example", "sec-fetch-site": "same-origin" }
    ];
    for (const headers of crossSite) {
      const refused = await confirm(booted.app, token, headers);
      expect(refused.statusCode, JSON.stringify(headers)).toBe(403);
      expect(sessionCookie(refused.headers["set-cookie"])).toBeUndefined();
    }
    expect((await auditRows(booted.store, "auth.break_glass_used")).every((row) => (row.metadata as { reason: string }).reason === "cross_site")).toBe(true);
    // A client on the host with no browser headers is accepted (curl), and the link was still unused.
    const accepted = await confirm(booted.app, token, {});
    expect(accepted.statusCode, accepted.body).toBe(200);
  });

  it("an allowed origin from another site (a separate API origin) is accepted", async () => {
    const booted = await boot({ WEB_ORIGIN: "https://studio.example.com,http://localhost:5173" });
    await registerAdmin(booted.store);
    const minted = await mint(booted, ["--email", "root@example.com"]);
    const opened = await confirm(booted.app, minted.token!, { origin: "https://studio.example.com", "sec-fetch-site": "same-site" });
    expect(opened.statusCode, opened.body).toBe(200);
  });

  it("refuses a non-admin, an unknown email and a missing master key, minting nothing", async () => {
    const booted = await boot();
    await new AuthService(booted.store, 24).register({ email: "dev@example.com", password: "Dev-Pass-123!", role: "builder" });
    const builder = await mint(booted, ["--email", "dev@example.com"]);
    expect(builder.code).toBe(2);
    expect(builder.err.join("\n")).toMatch(/admins only/);
    expect((await mint(booted, ["--email", "ghost@example.com"])).code).toBe(2);
    expect((await mint(booted, ["--email", "x@example.com", "--minutes", "90"])).code).toBe(2);
    const noKey = await runAdminBreakGlassCli(["--email", "dev@example.com"], {
      apiRoot: booted.dir,
      env: { ...booted.env, SECRET_MASTER_KEY_BASE64: "" },
      store: booted.store,
      io: { out: () => undefined, err: () => undefined }
    });
    expect(noKey).toBe(2);
    expect(await testSql(booted.store).all(`SELECT id_hash FROM pending_challenges`)).toEqual([]);
  });

  it("the command reports a failed delivery and a full one", async () => {
    const booted = await boot();
    await registerAdmin(booted.store);
    const failed = await mint(booted, ["--email", "root@example.com"], async () => ({ matched: 2, delivered: 1, failures: [{ channel: "slack", error: "Slack webhook answered HTTP 404" }] }));
    expect(failed.code).toBe(0);
    expect(failed.err.join("\n")).toMatch(/Warning: Alert delivery failed on 1 of 2 notification channel\(s\) \(slack: Slack webhook answered HTTP 404\)\. The link is still issued/);
    expect(failed.link).toBeDefined();
    const sent = await mint(booted, ["--email", "root@example.com"], async () => ({ matched: 1, delivered: 1, failures: [] }));
    expect(sent.out.join("\n")).toMatch(/Alert sent to 1 of 1 notification channel\(s\)\./);
    expect(sent.err).toEqual([]);
  });

  it("with AUDIT_LOG_ENABLED=false the break-glass rows are still written", async () => {
    const booted = await boot({ AUDIT_LOG_ENABLED: "false" });
    await registerAdmin(booted.store);
    const minted = await mint(booted, ["--email", "root@example.com"]);
    const sessionId = sessionIdOf(await confirm(booted.app, minted.token!));
    expect((await booted.app.inject({ method: "GET", url: "/api/workflows", cookies: { [COOKIE]: sessionId } })).statusCode).toBe(200);
    await vi.waitFor(async () => expect(await auditRows(booted.store, "auth.break_glass_request")).toHaveLength(1));
    expect(await auditRows(booted.store, "auth.break_glass_issued")).toHaveLength(1);
    expect(await auditRows(booted.store, "auth.break_glass_used")).toHaveLength(1);
    // Everything else follows the setting.
    await booted.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "root@example.com", password: "Root-Pass-123!" } });
    expect(await auditRows(booted.store, "user.login")).toEqual([]);
  });

  it("an expired break-glass session is refused (the policy exemption never covers its expiry)", async () => {
    const booted = await boot();
    await registerAdmin(booted.store);
    const minted = await mint(booted, ["--email", "root@example.com"]);
    const sessionId = sessionIdOf(await confirm(booted.app, minted.token!));
    await testSql(booted.store).run(`UPDATE sessions SET expires_at = ? WHERE id = ?`, "2000-01-01T00:00:00.000Z", sessionId);
    expect((await booted.app.inject({ method: "GET", url: "/api/auth/me", cookies: { [COOKIE]: sessionId } })).statusCode).toBe(401);
    expect((await confirm(booted.app, "bg_nope")).statusCode).toBe(401);
  });

  it("a real service account (kind='service', admin role) gets no link, and a link whose admin became one is refused", async () => {
    const booted = await boot();
    const owner = await registerAdmin(booted.store);
    const account = await booted.store.createServiceAccount({
      id: "svc_deploy",
      email: "deploy+0@service.invalid",
      role: "admin",
      description: null,
      createdBy: owner.id
    });
    expect(account).toMatchObject({ kind: "service", role: "admin" });
    // The stores map the kind, so the check reads the real row (a mapper that dropped it would fail open here).
    expect((await booted.store.getUserByEmail("deploy+0@service.invalid"))?.kind).toBe("service");
    const refused = await mint(booted, ["--email", "deploy+0@service.invalid"]);
    expect(refused.code).toBe(2);
    expect(refused.err.join("\n")).toMatch(/service account cannot sign in through break-glass/);
    expect(refused.link).toBeUndefined();
    expect(await auditRows(booted.store, "auth.break_glass_issued")).toEqual([
      expect.objectContaining({ outcome: "denied", metadata: expect.objectContaining({ reason: "service_account" }) })
    ]);

    // Minted for a person, then the row turns into a service account before the link is used: refused at confirm.
    const second = await registerAdmin(booted.store, "ops@example.com");
    const minted = await mint(booted, ["--email", "ops@example.com"]);
    expect(minted.code, minted.err.join("\n")).toBe(0);
    await testSql(booted.store).run(`UPDATE users SET kind = 'service' WHERE id = ?`, second.id);
    const opened = await confirm(booted.app, minted.token!);
    expect(opened.statusCode).toBe(401);
    expect(sessionCookie(opened.headers["set-cookie"])).toBeUndefined();
    expect(await auditRows(booted.store, "auth.break_glass_used")).toEqual([
      expect.objectContaining({ outcome: expect.not.stringMatching(/^success$/), metadata: expect.objectContaining({ reason: "service_account" }) })
    ]);
  });

  it("an admin service-account key cannot delete the last person who is an admin, so break-glass still has someone to sign in", async () => {
    const booted = await boot();
    const owner = await registerAdmin(booted.store);
    const login = await booted.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "root@example.com", password: "Root-Pass-123!" } });
    const cookie = { [COOKIE]: sessionIdOf(login) };
    await booted.store.createServiceAccount({ id: "svc_ci", email: "ci+0@service.invalid", role: "admin", description: null, createdBy: owner.id });
    const created = await booted.app.inject({ method: "POST", url: "/api/service-accounts/svc_ci/keys", payload: { name: "ci" }, cookies: cookie });
    expect(created.statusCode, created.body).toBe(201);
    const bearer = { authorization: `Bearer ${(created.json() as { key: string }).key}` };
    const refused = await booted.app.inject({ method: "DELETE", url: `/api/users/${owner.id}`, headers: bearer });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: "last_admin" });
    const minted = await mint(booted, ["--email", "root@example.com"]);
    expect(minted.code, minted.err.join("\n")).toBe(0);
    expect((await confirm(booted.app, minted.token!)).statusCode).toBe(200);
  });

  it("with every session and MFA policy on, a break-glass session skips idle, the limit, MFA and step-up, never its expiry", async () => {
    const booted = await boot({
      MFA_REQUIRED_ROLES: "admin",
      STEP_UP_MAX_AGE_MINUTES: "10",
      SESSION_IDLE_TIMEOUT_MINUTES: "15",
      SESSION_MAX_PER_USER: "1"
    });
    const admin = await registerAdmin(booted.store);
    const target = await new AuthService(booted.store, 24).register({ email: "dev@example.com", password: "Dev-Pass-123!", role: "builder" });
    const minted = await mint(booted, ["--email", "root@example.com"]);
    const sessionId = sessionIdOf(await confirm(booted.app, minted.token!));
    const as = { cookies: { [COOKIE]: sessionId } };

    // No MFA set up, no MFA check: the MFA rule and step-up do not apply to this session.
    const me = await booted.app.inject({ method: "GET", url: "/api/auth/me", ...as });
    expect(me.statusCode).toBe(200);
    expect(me.json()).not.toHaveProperty("mfaEnrollmentRequired");
    expect(me.json()).toMatchObject({ session: { breakGlass: true, idleTimeoutMinutes: null } });
    const promoted = await booted.app.inject({ method: "PUT", url: `/api/users/${target.id}`, payload: { role: "operator" }, ...as });
    expect(promoted.statusCode, promoted.body).toBe(200);

    // A normal sign-in under SESSION_MAX_PER_USER=1 does not end it.
    await booted.app.inject({ method: "POST", url: "/api/auth/login", payload: { email: "root@example.com", password: "Root-Pass-123!" } });
    // Idle past the timeout: still in.
    await testSql(booted.store).run(`UPDATE sessions SET last_seen_at = ? WHERE id = ?`, new Date(Date.now() - 40 * 60_000).toISOString(), sessionId);
    expect((await booted.app.inject({ method: "GET", url: "/api/workflows", ...as })).statusCode).toBe(200);
    expect((await booted.store.getSession(sessionId))?.revokedAt).toBeNull();

    // Its expiry always applies.
    await testSql(booted.store).run(`UPDATE sessions SET expires_at = ? WHERE id = ?`, "2000-01-01T00:00:00.000Z", sessionId);
    const expired = await booted.app.inject({ method: "GET", url: "/api/workflows", ...as });
    expect(expired.statusCode).toBe(401);
    expect(expired.json()).toMatchObject({ reason: "expired" });
    expect(admin.role).toBe("admin");
  });

  it("the network allowlists still apply: a refused address leaves the link unused", async () => {
    const booted = await boot({ NETWORK_ALLOW_UI: "10.0.0.0/8", NETWORK_ALLOW_API: "10.0.0.0/8", NETWORK_BREAK_GLASS_CIDRS: "none" });
    await registerAdmin(booted.store);
    const minted = await mint(booted, ["--email", "root@example.com"]);
    const outside = await confirm(booted.app, minted.token!, { origin: STUDIO_ORIGIN }, { remoteAddress: "198.51.100.7" });
    expect(outside.statusCode).toBe(403);
    expect(sessionCookie(outside.headers["set-cookie"])).toBeUndefined();
    const inside = await confirm(booted.app, minted.token!, { origin: STUDIO_ORIGIN }, { remoteAddress: "10.1.2.3" });
    expect(inside.statusCode, inside.body).toBe(200);
  });

  const sqliteOnly = testStoreKind() === "sqlite" && !fs.existsSync(path.join(API_ROOT, ".env")) ? it : it.skip;
  sqliteOnly("the command run as its own process mints a link the running API accepts, and exits (SQLite)", async () => {
    const booted = await boot();
    await registerAdmin(booted.store);
    const tsx = path.join(API_ROOT, "node_modules", ".bin", "tsx");
    const child = spawn(tsx, [path.join(API_ROOT, "src", "scripts", "admin-break-glass.ts"), "--email", "root@example.com"], {
      cwd: API_ROOT,
      env: { ...process.env, ...booted.env, DB_TYPE: "", DB_SQLITE_PATH: booted.file, NOTIFICATIONS_ENABLED: "false" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    expect(code, stderr).toBe(0);
    expect(stderr).toMatch(/nobody was alerted/);
    const opened = await confirm(booted.app, tokenOf(linkIn(stdout)!));
    expect(opened.statusCode, opened.body).toBe(200);
  }, 60_000);
});

const runPg = testPostgresUrl() ? describe : describe.skip;
if (!testPostgresUrl()) noticePostgresSkipped("break-glass link across two instances");

runPg("break-glass link on two instances (Postgres)", () => {
  let primary: TestStore | undefined;
  const replicas: Array<{ app: FastifyInstance; store: Store }> = [];

  afterEach(async () => {
    for (const replica of replicas.splice(0)) {
      await replica.app.close();
      await replica.store.close();
    }
    await primary?.cleanup();
    primary = undefined;
  }, 60_000);

  it("confirmed on both instances at once, the link signs in exactly once", async () => {
    primary = await createTestStore({ kind: "postgres" });
    const masterKey = crypto.randomBytes(32).toString("base64");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-break-glass-pg-"));
    cleanups.push(async () => fs.rmSync(dir, { recursive: true, force: true }));
    for (const name of ["bg-a", "bg-b"]) {
      const store = await openTestStoreTwin(primary, { maxConnections: 6 });
      await store.ensureDefaultProject();
      const config = parseConfig({
        LOG_LEVEL: "fatal",
        SEED_SAMPLE_WORKFLOWS: "false",
        SECRET_MASTER_KEY_BASE64: masterKey,
        COOKIE_SECURE: "false",
        RATE_LIMIT_ENABLED: "false",
        MCP_PROBE_INTERVAL_MS: "0",
        GIT_SYNC_WORKDIR: path.join(dir, name),
        DB_TYPE: "postgres",
        DB_POSTGRESDB_HOST: "unused-the-store-is-passed-in",
        HA_ENABLED: "true",
        HA_INSTANCE_ID: name,
        HA_RENEW_INTERVAL_MS: "100",
        CLUSTER_HEARTBEAT_MS: "200",
        CLUSTER_INSTANCE_TIMEOUT_MS: "5000"
      });
      const app = await createApp(config, store, new SecretService(store, masterKey), new AuthService(store, config.SESSION_TTL_HOURS), undefined, undefined, undefined, {
        lifecycle: new AppLifecycle()
      });
      await app.ready();
      replicas.push({ app, store });
    }
    await registerAdmin(primary.store);

    for (let round = 0; round < 5; round++) {
      const out: string[] = [];
      const code = await runAdminBreakGlassCli(["--email", "root@example.com"], {
        apiRoot: dir,
        env: { SECRET_MASTER_KEY_BASE64: masterKey, LOG_LEVEL: "fatal" },
        store: primary.store,
        notify: async () => ({ matched: 1, delivered: 1, failures: [] }),
        io: { out: (line) => out.push(line), err: () => undefined }
      });
      expect(code).toBe(0);
      const token = tokenOf(linkIn(out.join("\n"))!);
      const responses = await Promise.all(replicas.map((replica) => confirm(replica.app, token)));
      expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 401]);
      expect(responses.filter((response) => sessionCookie(response.headers["set-cookie"])).length).toBe(1);
    }
    const user = (await primary.store.getUserByEmail("root@example.com"))!;
    expect((await primary.store.listUserSessions(user.id)).filter((session) => session.breakGlass)).toHaveLength(5);
  }, 120_000);
});
