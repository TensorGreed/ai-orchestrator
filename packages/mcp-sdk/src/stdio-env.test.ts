import { describe, expect, it } from "vitest";
import { buildHostStdioEnv, parseStdioEnvPassthrough, STDIO_ENV_ALLOWLIST } from "./stdio-env";

const API_ENV: NodeJS.ProcessEnv = {
  PATH: "/usr/bin:/bin",
  HOME: "/home/api",
  LANG: "en_US.UTF-8",
  LC_ALL: "en_US.UTF-8",
  LC_CTYPE: "UTF-8",
  TMPDIR: "/tmp",
  HTTPS_PROXY: "http://proxy:3128",
  https_proxy: "http://proxy:3128",
  NODE_EXTRA_CA_CERTS: "/etc/ca.pem",
  npm_config_cache: "/cache/npm",
  SECRET_MASTER_KEY_BASE64: "c2VjcmV0",
  DATABASE_URL: "postgres://user:pw@db/l2m",
  OPENAI_API_KEY: "sk-test",
  NODE_OPTIONS: "--require /opt/apm.js",
  npm_config_registry: "https://user:token@registry.example/",
  PIP_INDEX_URL: "https://user:token@pypi.example/simple",
  LD_PRELOAD: "/tmp/evil.so",
  MY_APP_TOKEN: "abc",
  MY_APP_REGION: "eu",
  JAVA_HOME: "/opt/java"
};

describe("buildHostStdioEnv", () => {
  it("passes only allowlisted variables by default", () => {
    const env = buildHostStdioEnv(API_ENV, {}, undefined, "linux");
    expect(env).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/home/api",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      LC_CTYPE: "UTF-8",
      TMPDIR: "/tmp",
      HTTPS_PROXY: "http://proxy:3128",
      https_proxy: "http://proxy:3128",
      NODE_EXTRA_CA_CERTS: "/etc/ca.pem",
      npm_config_cache: "/cache/npm"
    });
  });

  it("never passes the master key, database URLs, provider keys, NODE_OPTIONS, loader variables or index URLs by default", () => {
    const env = buildHostStdioEnv(API_ENV, {}, {}, "linux");
    for (const name of ["SECRET_MASTER_KEY_BASE64", "DATABASE_URL", "OPENAI_API_KEY", "NODE_OPTIONS", "npm_config_registry", "PIP_INDEX_URL", "LD_PRELOAD"]) {
      expect(env).not.toHaveProperty(name);
    }
  });

  it("matches names case-sensitively off Windows", () => {
    const env = buildHostStdioEnv({ path: "/x", Home: "/h", SystemRoot: "C:\\Windows" }, {}, undefined, "linux");
    // SystemRoot is on the list as spelled; `path` and `Home` are not.
    expect(env).toEqual({ SystemRoot: "C:\\Windows" });
  });

  it("matches names regardless of case on Windows and keeps their spelling", () => {
    const source: NodeJS.ProcessEnv = {
      Path: "C:\\Windows\\system32",
      SYSTEMROOT: "C:\\Windows",
      windir: "C:\\Windows",
      COMSPEC: "C:\\Windows\\system32\\cmd.exe",
      PathExt: ".COM;.EXE;.CMD",
      APPDATA: "C:\\Users\\a\\AppData\\Roaming",
      "PROGRAMFILES(X86)": "C:\\Program Files (x86)",
      Lc_Time: "x",
      SECRET_MASTER_KEY_BASE64: "c2VjcmV0"
    };
    const env = buildHostStdioEnv(source, {}, undefined, "win32");
    expect(env).toEqual({
      Path: "C:\\Windows\\system32",
      SYSTEMROOT: "C:\\Windows",
      windir: "C:\\Windows",
      COMSPEC: "C:\\Windows\\system32\\cmd.exe",
      PathExt: ".COM;.EXE;.CMD",
      APPDATA: "C:\\Users\\a\\AppData\\Roaming",
      "PROGRAMFILES(X86)": "C:\\Program Files (x86)",
      Lc_Time: "x"
    });
  });

  it("adds passthrough names and prefixes", () => {
    const env = buildHostStdioEnv(API_ENV, {}, { passthrough: ["JAVA_HOME", "MY_APP_*"] }, "linux");
    expect(env.JAVA_HOME).toBe("/opt/java");
    expect(env.MY_APP_TOKEN).toBe("abc");
    expect(env.MY_APP_REGION).toBe("eu");
    expect(env).not.toHaveProperty("SECRET_MASTER_KEY_BASE64");
  });

  it("matches passthrough entries regardless of case on Windows only", () => {
    expect(buildHostStdioEnv({ My_App_Key: "1" }, {}, { passthrough: ["MY_APP_*"] }, "win32")).toEqual({ My_App_Key: "1" });
    expect(buildHostStdioEnv({ My_App_Key: "1" }, {}, { passthrough: ["MY_APP_*"] }, "linux")).toEqual({});
  });

  it("passes the whole environment with inherit", () => {
    const env = buildHostStdioEnv(API_ENV, { EXTRA: "1" }, { inherit: true }, "linux");
    expect(env).toEqual({ ...API_ENV, EXTRA: "1" });
  });

  it("lets the server's own variables override allowlisted ones", () => {
    const env = buildHostStdioEnv(API_ENV, { PATH: "/opt/server/bin", HOME: "/srv", SERVER_TOKEN: "t" }, undefined, "linux");
    expect(env.PATH).toBe("/opt/server/bin");
    expect(env.HOME).toBe("/srv");
    expect(env.SERVER_TOKEN).toBe("t");
  });

  it("passes a server variable even when its name is not allowlisted (its config defines it)", () => {
    const env = buildHostStdioEnv(API_ENV, { DATABASE_URL: "sqlite://server.db" }, undefined, "linux");
    expect(env.DATABASE_URL).toBe("sqlite://server.db");
  });

  it("replaces a differently cased variable on Windows instead of passing both", () => {
    const env = buildHostStdioEnv({ Path: "C:\\api" }, { PATH: "C:\\server" }, undefined, "win32");
    expect(env).toEqual({ PATH: "C:\\server" });
  });

  it("skips variables without a value", () => {
    expect(buildHostStdioEnv({ PATH: undefined, HOME: "/h" }, {}, undefined, "linux")).toEqual({ HOME: "/h" });
  });

  it("lists the core names", () => {
    for (const name of ["PATH", "HOME", "LC_*", "SystemRoot", "HTTP_PROXY", "no_proxy", "SSL_CERT_FILE", "REQUESTS_CA_BUNDLE"]) {
      expect(STDIO_ENV_ALLOWLIST).toContain(name);
    }
    expect(STDIO_ENV_ALLOWLIST).not.toContain("NODE_OPTIONS");
  });
});

describe("parseStdioEnvPassthrough", () => {
  it("splits, trims and de-duplicates", () => {
    expect(parseStdioEnvPassthrough(" JAVA_HOME, MY_APP_* ,,JAVA_HOME,ProgramFiles(x86)")).toEqual({
      names: ["JAVA_HOME", "MY_APP_*", "ProgramFiles(x86)"],
      problems: []
    });
  });

  it("reads empty and unset as nothing", () => {
    expect(parseStdioEnvPassthrough("")).toEqual({ names: [], problems: [] });
    expect(parseStdioEnvPassthrough(undefined)).toEqual({ names: [], problems: [] });
  });

  it("refuses prefixes that are too broad, the master key and entries with values, without echoing values", () => {
    for (const entry of ["S*", "_*", "SE*", "SECRET_*", "SECRET_MASTER_KEY_BASE64", "secret_master*"]) {
      expect(parseStdioEnvPassthrough(entry).problems, entry).toHaveLength(1);
    }
    expect(parseStdioEnvPassthrough("MY_*").problems).toEqual([]);
    const withValue = parseStdioEnvPassthrough("TOKEN=s3cr3t-value");
    expect(withValue.problems).toHaveLength(1);
    expect(withValue.problems[0]).not.toContain("s3cr3t");
  });

  it("refuses * alone and names that are not variable names", () => {
    const parsed = parseStdioEnvPassthrough("*,A B,1ABC,*FOO,GOOD");
    expect(parsed.names).toEqual(["GOOD"]);
    expect(parsed.problems).toHaveLength(4);
    expect(parsed.problems[0]).toContain("MCP_STDIO_INHERIT_ENV");
  });
});
