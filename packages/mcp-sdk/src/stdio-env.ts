/**
 * The environment a stdio MCP server started on the host (not in a container
 * sandbox) receives.
 *
 * By default it gets only a small allowlist of the API's own variables (what a
 * program needs to start, find its tools, reach the network and read its
 * caches) plus the variables its own config defines. Everything else the API
 * holds (the master key, database URLs, model provider keys) stays out of the
 * server's process. An operator can add names (`passthrough`) or go back to
 * the whole environment (`inherit`).
 */

/** How a host-launched stdio server's environment is built. */
export interface StdioEnvPolicy {
  /** Pass the API's whole environment, as releases before this one did. Default false. */
  inherit?: boolean;
  /** More names to pass from the API's environment. A trailing `*` matches a prefix (`MY_APP_*`). */
  passthrough?: readonly string[];
}

/**
 * Names passed by default. A trailing `*` matches a prefix.
 *
 * Left out on purpose:
 * - `NODE_OPTIONS`: the API's own runtime flags (`--require` / `--import`
 *   preloads such as instrumentation, `--inspect`, memory limits) would load
 *   into every Node-based server.
 * - Package index URLs (`PIP_INDEX_URL`, `UV_INDEX_URL`, `npm_config_registry`,
 *   `*_authToken`): they can carry credentials. npx, pip and uv still read
 *   their config files under `HOME` / `APPDATA`.
 * - `LD_*` / `DYLD_*`, `PYTHONPATH`, `NODE_PATH`: they change what code a
 *   program loads.
 * Proxy URLs are passed as they are, credentials included: without them a
 * server behind a proxy cannot reach anything.
 */
export const STDIO_ENV_ALLOWLIST: readonly string[] = Object.freeze([
  // Process basics.
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LANGUAGE",
  "LC_*",
  "TZ",
  "TERM",
  "TMPDIR",
  "TEMP",
  "TMP",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  // Windows.
  "SystemRoot",
  "SystemDrive",
  "windir",
  "ComSpec",
  "PATHEXT",
  "APPDATA",
  "LOCALAPPDATA",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "ProgramW6432",
  "CommonProgramFiles",
  "CommonProgramFiles(x86)",
  "CommonProgramW6432",
  "ALLUSERSPROFILE",
  "PUBLIC",
  "USERNAME",
  "USERDOMAIN",
  "COMPUTERNAME",
  "NUMBER_OF_PROCESSORS",
  "PROCESSOR_ARCHITECTURE",
  "OS",
  // Network and certificates.
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "NODE_EXTRA_CA_CERTS",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REQUESTS_CA_BUNDLE",
  // Package managers that start servers (npx, uvx, pip): locations, certificates and proxies only.
  "npm_config_cache",
  "npm_config_userconfig",
  "npm_config_globalconfig",
  "npm_config_prefix",
  "npm_config_cafile",
  "npm_config_strict_ssl",
  "npm_config_proxy",
  "npm_config_https_proxy",
  "npm_config_noproxy",
  "NPM_CONFIG_CACHE",
  "NPM_CONFIG_USERCONFIG",
  "NPM_CONFIG_GLOBALCONFIG",
  "NPM_CONFIG_PREFIX",
  "NPM_CONFIG_CAFILE",
  "NPM_CONFIG_STRICT_SSL",
  "NPM_CONFIG_PROXY",
  "NPM_CONFIG_HTTPS_PROXY",
  "NPM_CONFIG_NOPROXY",
  "COREPACK_HOME",
  "UV_CACHE_DIR",
  "UV_TOOL_DIR",
  "UV_TOOL_BIN_DIR",
  "UV_PYTHON_INSTALL_DIR",
  "UV_PYTHON_PREFERENCE",
  "UV_PYTHON_DOWNLOADS",
  "UV_NATIVE_TLS",
  "UV_CONFIG_FILE",
  "PIP_CACHE_DIR",
  "PIP_CERT",
  "PIP_CONFIG_FILE"
]);

/** A name, or a name prefix ending in `*`, as `MCP_STDIO_ENV_PASSTHROUGH` takes them. */
const PASSTHROUGH_ENTRY = /^[A-Za-z_][A-Za-z0-9_.()-]{0,127}\*?$/;
/** Shortest prefix a `*` entry may have, so a slip like `S*` cannot pass most of the environment. */
const MIN_PASSTHROUGH_PREFIX = 3;
/** The API's master key never goes to a server through passthrough; MCP_STDIO_INHERIT_ENV is the explicit way. */
const NEVER_PASSED = "SECRET_MASTER_KEY_BASE64";

/**
 * Parse a comma-separated passthrough list. Returns the entries and a
 * problem for each one that is not a variable name or prefix (`*` alone is
 * refused: that is what `inherit` is for).
 */
export function parseStdioEnvPassthrough(raw: string | undefined): { names: string[]; problems: string[] } {
  const names: string[] = [];
  const problems: string[] = [];
  for (const entry of (raw ?? "").split(",").map((value) => value.trim()).filter(Boolean)) {
    if (entry.includes("=")) {
      // Never echo it: the part after '=' may be a value.
      problems.push("an entry contains '='; list variable names only, without values.");
      continue;
    }
    if (!PASSTHROUGH_ENTRY.test(entry)) {
      problems.push(
        entry === "*"
          ? "'*' would pass every variable; set MCP_STDIO_INHERIT_ENV=true for that instead."
          : `'${entry.slice(0, 60)}' is not an environment variable name (a trailing * is allowed).`
      );
      continue;
    }
    if (entry.endsWith("*") && entry.length - 1 < MIN_PASSTHROUGH_PREFIX) {
      problems.push(`'${entry}' is too broad: a prefix needs at least ${MIN_PASSTHROUGH_PREFIX} characters before the *.`);
      continue;
    }
    const upper = entry.toUpperCase();
    if (entry.endsWith("*") ? NEVER_PASSED.startsWith(upper.slice(0, -1)) : upper === NEVER_PASSED) {
      problems.push(`'${entry}' would pass ${NEVER_PASSED}, which never goes to an MCP server through this list.`);
      continue;
    }
    if (!names.includes(entry)) names.push(entry);
  }
  return { names, problems };
}

function matcher(patterns: readonly string[], caseInsensitive: boolean): (name: string) => boolean {
  const fold = (value: string) => (caseInsensitive ? value.toUpperCase() : value);
  const exact = new Set<string>();
  const prefixes: string[] = [];
  for (const pattern of patterns) {
    if (pattern.endsWith("*")) prefixes.push(fold(pattern.slice(0, -1)));
    else exact.add(fold(pattern));
  }
  return (name) => {
    const key = fold(name);
    return exact.has(key) || prefixes.some((prefix) => key.startsWith(prefix));
  };
}

/**
 * The environment for a host-launched stdio server: the allowed part of
 * `source` (all of it with `inherit`), then the server's own variables,
 * which win over anything taken from `source`. On Windows names match
 * without regard to case, and a server variable replaces a source variable
 * whose name differs only in case.
 */
export function buildHostStdioEnv(
  source: NodeJS.ProcessEnv,
  serverEnv: Record<string, string>,
  policy?: StdioEnvPolicy,
  platform: NodeJS.Platform = process.platform
): Record<string, string> {
  const windows = platform === "win32";
  const allowed = policy?.inherit ? () => true : matcher([...STDIO_ENV_ALLOWLIST, ...(policy?.passthrough ?? [])], windows);
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (typeof value === "string" && allowed(name)) env[name] = value;
  }
  for (const [name, value] of Object.entries(serverEnv)) {
    if (windows) {
      const upper = name.toUpperCase();
      for (const existing of Object.keys(env)) {
        if (existing !== name && existing.toUpperCase() === upper) delete env[existing];
      }
    }
    env[name] = value;
  }
  return env;
}
