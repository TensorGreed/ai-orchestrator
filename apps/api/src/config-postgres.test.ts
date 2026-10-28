/**
 * Phase 13.1 — database settings (Q7): checked only when DB_TYPE=postgres, DB_POSTGRESDB_URL wins, TLS verifies
 * certificates by default, private CA, explicit opt-out with a warning, and the password never reaches an error or log.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describePostgresSettings, isPostgresDbType, parseConfig, parsePostgresSettings } from "./config.js";
import { createStore, postgresStoreConfig } from "./db/create-store.js";
import { SqliteStore } from "./db/database.js";
import { postgresPoolConfig } from "./db/postgres-store.js";

const SECRET = "s3cr3t-P@ss word";
const PEM = "-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n";

let tempDir: string;
beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "l2m-config-pg-"));
});
afterAll(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function errorOf(fn: () => unknown): Error {
  try {
    fn();
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected a throw");
}

describe("DB_TYPE", () => {
  it("selects Postgres only for postgres / postgresql (any case); anything else stays SQLite", () => {
    expect(isPostgresDbType("postgres")).toBe(true);
    expect(isPostgresDbType(" PostgreSQL ")).toBe(true);
    expect(isPostgresDbType(undefined)).toBe(false);
    expect(isPostgresDbType("sqlite")).toBe(false);
    expect(isPostgresDbType("")).toBe(false);
  });

  it("SQLite ignores the Postgres variables entirely, even invalid ones", () => {
    expect(() => parseConfig({ DB_TYPE: "sqlite", DB_POSTGRESDB_PORT: "not-a-port", DB_POSTGRESDB_SSL: "maybe" })).not.toThrow();
    expect(() => parseConfig({ DB_POSTGRESDB_URL: "::::" })).not.toThrow();
  });

  it("Postgres fails fast at config time, naming the variable", () => {
    const error = errorOf(() => parseConfig({ DB_TYPE: "postgres", DB_POSTGRESDB_PORT: "99999" }));
    expect(error.message).toMatch(/DB_POSTGRESDB_PORT is invalid \(1-65535\)/);
  });
});

describe("parsePostgresSettings", () => {
  it("keeps today's defaults and variable names", () => {
    const settings = parsePostgresSettings({});
    expect(settings).toMatchObject({
      host: "localhost",
      port: 5432,
      database: "ai_orchestrator",
      user: "postgres",
      password: "",
      ssl: false,
      poolSize: 10,
      source: "variables",
      warnings: []
    });
    expect(
      parsePostgresSettings({
        DB_POSTGRESDB_HOST: "db.internal",
        DB_POSTGRESDB_PORT: "6543",
        DB_POSTGRESDB_DATABASE: "l2m",
        DB_POSTGRESDB_USER: "app",
        DB_POSTGRESDB_PASSWORD: SECRET,
        DB_POSTGRESDB_POOL_SIZE: "20"
      })
    ).toMatchObject({ host: "db.internal", port: 6543, database: "l2m", user: "app", password: SECRET, poolSize: 20 });
  });

  it("treats empty values as unset (as the .env.example template leaves them)", () => {
    expect(parsePostgresSettings({ DB_POSTGRESDB_PORT: "", DB_POSTGRESDB_SSL: "", DB_POSTGRESDB_POOL_SIZE: " " })).toMatchObject({
      port: 5432,
      ssl: false,
      poolSize: 10
    });
  });

  it("DB_POSTGRESDB_URL wins over the separate variables and decodes user and password", () => {
    const settings = parsePostgresSettings({
      DB_POSTGRESDB_URL: `postgresql://app%40corp:${encodeURIComponent(SECRET)}@pg.example.com:6000/l2m_prod`,
      DB_POSTGRESDB_HOST: "ignored",
      DB_POSTGRESDB_PASSWORD: "ignored"
    });
    expect(settings).toMatchObject({ host: "pg.example.com", port: 6000, database: "l2m_prod", user: "app@corp", password: SECRET, source: "url", ssl: false });
    expect(parsePostgresSettings({ DB_POSTGRESDB_URL: "postgres://u@[::1]/db" })).toMatchObject({ host: "::1", port: 5432 });
  });

  it("an invalid URL fails without echoing it (it may hold the password)", () => {
    for (const url of [`http://u:${SECRET}@h/db`, `not a url ${SECRET}`, `postgres://u:${SECRET}@h/db?options=-c%20x`, `postgres://u:${SECRET}@h/db?sslmode=bogus`]) {
      const error = errorOf(() => parsePostgresSettings({ DB_POSTGRESDB_URL: url }));
      expect(error.message).toMatch(/DB_POSTGRESDB_URL/);
      expect(error.message).not.toContain(SECRET);
      expect(error.message).not.toContain(encodeURIComponent(SECRET));
    }
  });

  it("rejects bad numbers and booleans without echoing other values", () => {
    const error = errorOf(() =>
      parsePostgresSettings({ DB_POSTGRESDB_PASSWORD: SECRET, DB_POSTGRESDB_POOL_SIZE: "0", DB_POSTGRESDB_SSL: "maybe" })
    );
    expect(error.message).toMatch(/DB_POSTGRESDB_POOL_SIZE is invalid \(1-1000\)/);
    expect(error.message).toMatch(/DB_POSTGRESDB_SSL is invalid \(true or false\)/);
    expect(error.message).not.toContain(SECRET);
  });

  it("TLS on verifies certificates by default", () => {
    const settings = parsePostgresSettings({ DB_POSTGRESDB_SSL: "true" });
    expect(settings.ssl).toEqual({ rejectUnauthorized: true });
    expect(settings.warnings).toEqual([]);
    expect(describePostgresSettings(settings)).toContain("TLS, certificate verified");
    expect(postgresPoolConfig(postgresStoreConfig(settings)).ssl).toEqual({ rejectUnauthorized: true });
  });

  it("sslmode in the URL turns TLS on or off; DB_POSTGRESDB_SSL alone decides when the URL has no sslmode", () => {
    expect(parsePostgresSettings({ DB_POSTGRESDB_URL: "postgres://u@h/db?sslmode=require" }).ssl).toEqual({ rejectUnauthorized: true });
    expect(parsePostgresSettings({ DB_POSTGRESDB_URL: "postgres://u@h/db?sslmode=verify-ca" }).ssl).toEqual({ rejectUnauthorized: true });
    expect(parsePostgresSettings({ DB_POSTGRESDB_URL: "postgres://u@h/db?sslmode=verify-full" }).ssl).toEqual({ rejectUnauthorized: true });
    expect(parsePostgresSettings({ DB_POSTGRESDB_URL: "postgres://u@h/db?sslmode=disable" }).ssl).toBe(false);
    expect(parsePostgresSettings({ DB_POSTGRESDB_URL: "postgres://u@h/db", DB_POSTGRESDB_SSL: "true" }).ssl).toEqual({ rejectUnauthorized: true });
    expect(parsePostgresSettings({ DB_POSTGRESDB_URL: "postgres://u@h/db", DB_POSTGRESDB_SSL: "false" }).ssl).toBe(false);
    // Both set and agreeing is fine.
    expect(parsePostgresSettings({ DB_POSTGRESDB_URL: "postgres://u@h/db?sslmode=verify-full", DB_POSTGRESDB_SSL: "true" }).ssl).toEqual({
      rejectUnauthorized: true
    });
    expect(parsePostgresSettings({ DB_POSTGRESDB_URL: "postgres://u@h/db?sslmode=disable", DB_POSTGRESDB_SSL: "false" }).ssl).toBe(false);
  });

  it("sslmode in the URL and DB_POSTGRESDB_SSL that disagree fail fast, naming both and never echoing the URL", () => {
    for (const [mode, ssl] of [
      ["verify-full", "false"],
      ["require", "false"],
      ["disable", "true"]
    ]) {
      const error = errorOf(() =>
        parsePostgresSettings({ DB_POSTGRESDB_URL: `postgres://u:${encodeURIComponent(SECRET)}@h/db?sslmode=${mode}`, DB_POSTGRESDB_SSL: ssl })
      );
      expect(error.message).toMatch(/DB_POSTGRESDB_URL/);
      expect(error.message).toMatch(/DB_POSTGRESDB_SSL\b/);
      expect(error.message).not.toContain(SECRET);
      expect(error.message).not.toContain(encodeURIComponent(SECRET));
    }
  });

  it("sslmode=allow / prefer are refused (TLS would be optional); the hint says require verifies certificates here", () => {
    for (const mode of ["allow", "prefer"]) {
      const error = errorOf(() => parsePostgresSettings({ DB_POSTGRESDB_URL: `postgres://u:${encodeURIComponent(SECRET)}@h/db?sslmode=${mode}` }));
      expect(error.message).toMatch(/DB_POSTGRESDB_URL/);
      expect(error.message).toMatch(/use require or disable/);
      expect(error.message).toMatch(/DB_POSTGRESDB_SSL_CA/);
      expect(error.message).not.toContain(SECRET);
    }
  });

  it("a URL with more than one sslmode is refused (libpq would use the last, a first-wins read would differ)", () => {
    const error = errorOf(() => parsePostgresSettings({ DB_POSTGRESDB_URL: `postgres://u:${encodeURIComponent(SECRET)}@h/db?sslmode=disable&sslmode=require` }));
    expect(error.message).toMatch(/^Invalid database configuration: /);
    expect(error.message).toMatch(/more than one sslmode/);
    expect(error.message).not.toContain(SECRET);
    expect(error.message).not.toContain("postgres://");
  });

  it("with an sslmode in the URL, the CA and REJECT_UNAUTHORIZED hints point at the sslmode, not at DB_POSTGRESDB_SSL=true", () => {
    const ca = errorOf(() => parsePostgresSettings({ DB_POSTGRESDB_URL: "postgres://u:p@h/db?sslmode=disable", DB_POSTGRESDB_SSL_CA: PEM }));
    expect(ca.message).toMatch(/sslmode in DB_POSTGRESDB_URL/);
    expect(ca.message).not.toMatch(/DB_POSTGRESDB_SSL=true/);
    const reject = errorOf(() => parsePostgresSettings({ DB_POSTGRESDB_URL: "postgres://u:p@h/db?sslmode=disable", DB_POSTGRESDB_SSL_REJECT_UNAUTHORIZED: "false" }));
    expect(reject.message).toMatch(/sslmode in DB_POSTGRESDB_URL/);
    expect(reject.message).not.toMatch(/DB_POSTGRESDB_SSL=true/);
  });

  it("a malformed percent escape in the URL is a database configuration error, not a bare URIError", () => {
    for (const url of [`postgres://u:p%ZZ${SECRET}@h/db`, `postgres://u%E0%A4%A@h/db`, `postgres://u@h/d%ZZb`]) {
      const error = errorOf(() => parsePostgresSettings({ DB_POSTGRESDB_URL: url }));
      expect(error).not.toBeInstanceOf(URIError);
      expect(error.message).toMatch(/^Invalid database configuration: DB_POSTGRESDB_URL/);
      expect(error.message).not.toContain(SECRET);
    }
  });

  it("a copied .env.example with the suggested URL uncommented keeps TLS on (no shipped default turns it off)", () => {
    const example = fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../.env.example"), "utf8");
    const env: Record<string, string> = {};
    for (const rawLine of example.split(/\r?\n/)) {
      // Uncomment the suggested URL line, as the template invites; leave every other comment alone.
      const line = /^#\s*DB_POSTGRESDB_URL=/.test(rawLine) ? rawLine.replace(/^#\s*/, "") : rawLine;
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (match) env[match[1]] = match[2];
    }
    expect(env.DB_POSTGRESDB_URL).toMatch(/sslmode=verify-full/);
    // The shipped template sets no DB_POSTGRESDB_* value besides the uncommented URL: the defaults come from code.
    expect(Object.keys(env).filter((key) => key.startsWith("DB_POSTGRESDB_"))).toEqual(["DB_POSTGRESDB_URL"]);
    const settings = parsePostgresSettings(env);
    expect(settings.ssl).toEqual({ rejectUnauthorized: true });
    expect(describePostgresSettings(settings)).toContain("TLS, certificate verified");
  });

  it("DB_POSTGRESDB_SSL_CA takes a PEM (escaped newlines too) or a file path", () => {
    // An inline value is trimmed like every setting; the PEM stays valid.
    expect(parsePostgresSettings({ DB_POSTGRESDB_SSL: "true", DB_POSTGRESDB_SSL_CA: PEM }).ssl).toEqual({ rejectUnauthorized: true, ca: PEM.trimEnd() });
    expect(parsePostgresSettings({ DB_POSTGRESDB_SSL: "true", DB_POSTGRESDB_SSL_CA: PEM.replace(/\n/g, "\\n") }).ssl).toEqual({
      rejectUnauthorized: true,
      ca: PEM
    });
    const file = path.join(tempDir, "ca.pem");
    fs.writeFileSync(file, PEM);
    const settings = parsePostgresSettings({ DB_POSTGRESDB_SSL: "true", DB_POSTGRESDB_SSL_CA: file });
    expect(settings.ssl).toEqual({ rejectUnauthorized: true, ca: PEM });
    expect(postgresPoolConfig(postgresStoreConfig(settings)).ssl).toEqual({ rejectUnauthorized: true, ca: PEM });
  });

  it("an unreadable or non-PEM CA, or a CA without TLS, fails fast", () => {
    expect(errorOf(() => parsePostgresSettings({ DB_POSTGRESDB_SSL: "true", DB_POSTGRESDB_SSL_CA: path.join(tempDir, "missing.pem") })).message).toMatch(
      /DB_POSTGRESDB_SSL_CA must be a PEM/
    );
    const notPem = path.join(tempDir, "not.pem");
    fs.writeFileSync(notPem, "hello");
    expect(errorOf(() => parsePostgresSettings({ DB_POSTGRESDB_SSL: "true", DB_POSTGRESDB_SSL_CA: notPem })).message).toMatch(/must be a PEM/);
    expect(errorOf(() => parsePostgresSettings({ DB_POSTGRESDB_SSL_CA: PEM })).message).toMatch(/TLS is off/);
  });

  it("DB_POSTGRESDB_SSL_REJECT_UNAUTHORIZED=false is an explicit opt-out with a warning", () => {
    const settings = parsePostgresSettings({ DB_POSTGRESDB_SSL: "true", DB_POSTGRESDB_SSL_REJECT_UNAUTHORIZED: "false" });
    expect(settings.ssl).toEqual({ rejectUnauthorized: false });
    expect(settings.warnings).toHaveLength(1);
    expect(settings.warnings[0]).toMatch(/NOT verified/);
    expect(describePostgresSettings(settings)).toContain("certificate NOT verified");
    expect(errorOf(() => parsePostgresSettings({ DB_POSTGRESDB_SSL_REJECT_UNAUTHORIZED: "false" })).message).toMatch(/TLS is off/);
    expect(parsePostgresSettings({ DB_POSTGRESDB_SSL: "true", DB_POSTGRESDB_SSL_REJECT_UNAUTHORIZED: "true" }).warnings).toEqual([]);
  });

  it("the log description never holds the password", () => {
    const settings = parsePostgresSettings({ DB_POSTGRESDB_URL: `postgres://app:${encodeURIComponent(SECRET)}@h:5433/db` });
    const line = describePostgresSettings(settings);
    expect(line).toBe("postgres app@h:5433/db (no TLS)");
    expect(line).not.toContain(SECRET);
  });
});

describe("createStore", () => {
  it("SQLite with no new settings opens the given file, as before", async () => {
    const file = path.join(tempDir, "default.db");
    const logs: string[] = [];
    const store = await createStore({ dbFilePath: file, env: {}, log: { info: (m) => logs.push(m), warn: (m) => logs.push(m) } });
    try {
      expect(store).toBeInstanceOf(SqliteStore);
      expect(fs.existsSync(file)).toBe(true);
      expect(logs).toEqual([]);
    } finally {
      await store.close();
    }
  });

  it("SQLite honours DB_SQLITE_PATH when no path is passed", async () => {
    const file = path.join(tempDir, "from-env.db");
    const store = await createStore({ env: { DB_SQLITE_PATH: file } });
    try {
      expect(await store.storageLocation()).toBe(file);
    } finally {
      await store.close();
    }
  });

  it("Postgres prints the warning and a password-free target line, then reports a connection failure without the password", async () => {
    const logs: string[] = [];
    const env = {
      DB_TYPE: "postgres",
      // Port 1 on loopback: nothing listens, so the connection is refused quickly.
      DB_POSTGRESDB_URL: `postgres://app:${encodeURIComponent(SECRET)}@127.0.0.1:1/db`,
      DB_POSTGRESDB_SSL: "true",
      DB_POSTGRESDB_SSL_REJECT_UNAUTHORIZED: "false"
    };
    const error = await createStore({ env, log: { info: (m) => logs.push(m), warn: (m) => logs.push(m) } }).then(
      () => new Error("expected a failure"),
      (e: Error) => e
    );
    expect(logs.some((line) => /NOT verified/.test(line))).toBe(true);
    expect(logs).toContain("Database: postgres app@127.0.0.1:1/db (TLS, certificate NOT verified)");
    for (const line of [...logs, error.message, String(error.stack)]) {
      expect(line).not.toContain(SECRET);
      expect(line).not.toContain(encodeURIComponent(SECRET));
    }
  }, 30_000);
});

describe.skipIf(!process.env.TEST_POSTGRES_URL)("createStore against TEST_POSTGRES_URL", () => {
  it("TLS settings reach the driver: asking for TLS from a server without it fails instead of falling back to plain text", async () => {
    const url = new URL(process.env.TEST_POSTGRES_URL as string);
    url.searchParams.set("sslmode", "require");
    // The test server (lane container, CI service) runs without TLS, so the connection must be refused.
    const error = await createStore({ env: { DB_TYPE: "postgres", DB_POSTGRESDB_URL: url.toString() }, log: { info: () => undefined, warn: () => undefined } }).then(
      async (store) => {
        await (store as { close(): Promise<void> }).close();
        return new Error("connected without TLS");
      },
      (e: Error) => e
    );
    expect(error.message).toMatch(/does not support SSL/i);
  }, 30_000);
});

describe("cluster timings", () => {
  const pg = { DB_TYPE: "postgres", HA_ENABLED: "true" };

  it("with HA on Postgres, the timeout must be at least four heartbeats", () => {
    const error = errorOf(() => parseConfig({ ...pg, CLUSTER_HEARTBEAT_MS: "10000", CLUSTER_INSTANCE_TIMEOUT_MS: "30000" }));
    expect(error.message).toMatch(/CLUSTER_INSTANCE_TIMEOUT_MS \(30000\) must be at least 4 times CLUSTER_HEARTBEAT_MS \(10000\)/);
    expect(() => parseConfig({ ...pg, CLUSTER_HEARTBEAT_MS: "10000", CLUSTER_INSTANCE_TIMEOUT_MS: "39999" })).toThrow(/at least 4 times/);
    expect(() => parseConfig({ ...pg, CLUSTER_HEARTBEAT_MS: "10000", CLUSTER_INSTANCE_TIMEOUT_MS: "40000" })).not.toThrow();
  });

  it("keeps the defaults valid and ignores the rule without HA or on SQLite", () => {
    expect(() => parseConfig({ ...pg })).not.toThrow();
    expect(() => parseConfig({ DB_TYPE: "postgres", CLUSTER_HEARTBEAT_MS: "10000", CLUSTER_INSTANCE_TIMEOUT_MS: "30000" })).not.toThrow();
    expect(() => parseConfig({ HA_ENABLED: "true", CLUSTER_HEARTBEAT_MS: "10000", CLUSTER_INSTANCE_TIMEOUT_MS: "30000" })).not.toThrow();
  });
});
