/**
 * pnpm --filter @ai-orchestrator/api admin:break-glass -- --email <admin email> [--minutes 15]
 *
 * 13.2 — the recovery path when no admin can sign in (a sole admin locked out, an authenticator lost, SSO down). Run
 * it on the server host, with the API's settings: it mints a one-time sign-in link for that admin and prints it.
 * The link opens a studio page (the token is in the `#fragment`, so it never reaches a server log); the admin
 * confirms there, and gets a break-glass session: one hour, no renewal, exempt from the sign-in policies (not from
 * the network allowlists), every request audited. Opening the link without confirming uses nothing. Needs SECRET_MASTER_KEY_BASE64 and the API's database settings; shell
 * access to the host and its database is the proof, so nothing else is asked.
 *
 * The link is kept in the database (pending_challenges, only its sha256), so the running API, any instance of it,
 * sees it; it works once and expires after --minutes (5 to 60, default 15). The command records
 * `auth.break_glass_issued` in the audit log (even with AUDIT_LOG_ENABLED=false) and the log streams, and sends the
 * `auth.break_glass_used` alert to the notification channels. It says when no channel receives the alert or a send
 * failed, and still prints the link: the outage that calls for break-glass may be what took the channel down.
 *
 * Settings are loaded as the API loads them (env-files.ts). Exit codes: 0 link printed, 2 refused, 1 failed.
 */
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfig, ssoPostLoginUrl, type AppConfig } from "../config.js";
import { createStore } from "../db/create-store.js";
import type { Store } from "../db/store.js";
import { loadApiEnvFiles } from "../env-files.js";
import { AuditService } from "../services/audit-service.js";
import {
  BREAK_GLASS_ALERT_TIMEOUT_MS,
  BREAK_GLASS_LINK_MINUTES,
  BreakGlassRefusal,
  BreakGlassService,
  describeAlertResult,
  parseLinkMinutes
} from "../services/break-glass-service.js";
import { LogStreamingService } from "../services/log-streaming-service.js";
import { DbChallengeStore } from "../services/challenge-store.js";
import { NotificationService, type NotificationEvent, type NotifyResult } from "../services/notification-service.js";
import { SecretService } from "../services/secret-service.js";

/** apps/api: the default SQLite file is apps/api/data/orchestrator.db, as the API opens it. */
export const API_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** How long the command waits on the running API's SQLite write lock. */
const SQLITE_BUSY_TIMEOUT_MS = 15_000;

/** How long the command waits for the log streams before it moves on. */
const LOG_STREAM_TIMEOUT_MS = 10_000;

interface Args {
  email: string;
  minutes: number;
}

const USAGE = [
  "Usage: pnpm --filter @ai-orchestrator/api admin:break-glass -- --email <admin email> [--minutes 15]",
  "",
  "Mints a one-time sign-in link for an admin who cannot sign in. Run it on the server host with the API's settings.",
  "",
  "Options:",
  "  --email <address>   The admin to sign in (a human admin; other roles and service accounts are refused).",
  `  --minutes <n>       How long the link stays valid: ${BREAK_GLASS_LINK_MINUTES.min} to ${BREAK_GLASS_LINK_MINUTES.max} (default ${BREAK_GLASS_LINK_MINUTES.default}).`,
  "  --help, -h          Show this message.",
  "",
  "The link opens <APP_PUBLIC_URL, else the first WEB_ORIGIN>/#break_glass=<token>, a page where the admin confirms.",
  "The session lasts one hour; every request is audited and the notification channels are alerted."
].join("\n");

class UsageError extends Error {}

export function parseArgs(argv: string[]): Args | "help" {
  let email: string | undefined;
  let minutesRaw: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    // pnpm passes the `--` that separates its own options from the script's.
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") return "help";
    if (arg === "--email" || arg === "--minutes") {
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) throw new UsageError(`${arg} needs a value`);
      if (arg === "--email") email = value;
      else minutesRaw = value;
      continue;
    }
    const inline = /^--(email|minutes)=(.*)$/.exec(arg);
    if (inline) {
      if (inline[1] === "email") email = inline[2];
      else minutesRaw = inline[2];
      continue;
    }
    throw new UsageError(`Unknown argument: ${arg}`);
  }
  if (!email || !email.trim()) throw new UsageError("--email is required");
  try {
    return { email: email.trim(), minutes: parseLinkMinutes(minutesRaw) };
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
}

/** Where the link points: APP_PUBLIC_URL, else the first WEB_ORIGIN (whose dev server proxies /api to the API). */
export function linkBaseUrl(config: Pick<AppConfig, "APP_PUBLIC_URL" | "WEB_ORIGIN">): string {
  const base = config.APP_PUBLIC_URL.trim() || ssoPostLoginUrl(config.WEB_ORIGIN);
  return base.replace(/\/+$/, "");
}

/** Who ran the command and where (for the audit row and the alert). */
function commandOrigin(): string {
  let user = "unknown";
  try {
    user = os.userInfo().username || user;
  } catch {
    // No passwd entry (a container running as an arbitrary uid).
  }
  return `${user}@${os.hostname()} (admin:break-glass)`;
}

async function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)} s`)), ms);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

export interface CliOptions {
  apiRoot: string;
  /** The environment to read (process.env by default); .env files are loaded into it as the API does. */
  env?: Record<string, string | undefined>;
  io?: CliIo;
  /** Test seam: open this store instead of the configured one (it is not closed). */
  store?: Store;
  /** Test seam: replaces the notification channels. */
  notify?: (event: NotificationEvent) => Promise<NotifyResult>;
}

/** Runs the command; returns the exit code (0 link printed, 2 refused, 1 failed). */
export async function runAdminBreakGlassCli(argv: string[], options: CliOptions): Promise<number> {
  const io = options.io ?? { out: (line) => console.log(line), err: (line) => console.error(line) };
  let args: Args | "help";
  try {
    args = parseArgs(argv);
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    io.err(USAGE);
    return 2;
  }
  if (args === "help") {
    io.out(USAGE);
    return 0;
  }

  const env = options.env ?? process.env;
  loadApiEnvFiles(options.apiRoot, env);
  let config: AppConfig;
  try {
    config = parseConfig(env);
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return 2;
  }
  if (!config.SECRET_MASTER_KEY_BASE64) {
    io.err("SECRET_MASTER_KEY_BASE64 is not set: run the command with the API's settings (the same .env or environment).");
    return 2;
  }

  const dbPath = env.DB_SQLITE_PATH?.trim() ? path.resolve(env.DB_SQLITE_PATH.trim()) : path.resolve(options.apiRoot, "data", "orchestrator.db");
  const store =
    options.store ??
    (await createStore({
      dbFilePath: dbPath,
      env,
      log: { info: () => undefined, warn: (message) => io.err(message) },
      sqliteBusyTimeoutMs: SQLITE_BUSY_TIMEOUT_MS
    }));
  try {
    const secrets = new SecretService(store, config.SECRET_MASTER_KEY_BASE64);
    // Break-glass rows are written whatever AUDIT_LOG_ENABLED says, as in the API.
    const auditService = new AuditService(store, { enabled: true });
    // The issue event also goes to the external log streams: the copy someone on this host cannot edit.
    const logStreams = new LogStreamingService(store, config.SECRET_MASTER_KEY_BASE64, { enabled: config.LOG_STREAM_ENABLED });
    const notifications =
      options.notify ??
      (async (event: NotificationEvent) => {
        const service = new NotificationService(config, async () =>
          (await store.listNotificationConfigs()).map((c) => ({ channel: c.channel, enabled: c.enabled, config: c.config, events: c.events }))
        );
        return await service.notifyWithResults(event, { timeoutMs: BREAK_GLASS_ALERT_TIMEOUT_MS });
      });
    const service = new BreakGlassService({
      store,
      challenges: new DbChallengeStore(store, secrets),
      audit: async (event) => {
        await auditService.record(event);
        try {
          await logStreams.dispatchAudit(event);
          await withTimeout(logStreams.flush(), LOG_STREAM_TIMEOUT_MS, "Sending to the log streams");
        } catch (error) {
          io.err(`Warning: the audit event did not reach the log streams (${error instanceof Error ? error.message : String(error)}).`);
        }
      },
      notify: notifications
    });
    const origin = commandOrigin();
    let minted;
    try {
      minted = await service.mintLink({ email: args.email, minutes: args.minutes, origin, baseUrl: linkBaseUrl(config) });
    } catch (error) {
      if (error instanceof BreakGlassRefusal) {
        io.err(`Refused: ${error.message}`);
        return 2;
      }
      throw error;
    }
    let alertLine: string;
    let alertOk = false;
    try {
      const result = await service.sendIssuedAlert(minted, origin);
      alertOk = result.matched > 0 && result.failures.length === 0;
      alertLine = describeAlertResult(result);
    } catch (error) {
      alertLine = `The alert could not be sent (${error instanceof Error ? error.message : String(error)}).`;
    }
    if (alertOk) io.out(alertLine);
    else io.err(`Warning: ${alertLine} The link is still issued and recorded in the audit log.`);
    io.out(`Break-glass sign-in link for ${minted.user.email} (valid once, until ${minted.expiresAt}):`);
    io.out("");
    io.out(`  ${minted.link}`);
    io.out("");
    io.out("Open it in a browser that can reach the studio and confirm on the page it shows. The session lasts one hour");
    io.out("and every request is audited. Keep the link private: whoever confirms it first is signed in as this admin.");
    return 0;
  } catch (error) {
    io.err(`Failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    if (!options.store) await store.close();
  }
}

// Run only as a script (tests import the functions above).
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  // Exit as soon as the work is done: a stalled channel or pool must not keep the command alive after the link.
  runAdminBreakGlassCli(process.argv.slice(2), { apiRoot: API_ROOT }).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  );
}
