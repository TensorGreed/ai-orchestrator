/**
 * Pure helpers behind the MCP server form's transport choice: which adapter a
 * transport maps to, the connection template each one starts from, and the
 * conversion between the stdio fields (command, argument rows, environment
 * rows) and the connection object the API stores.
 */

export type ConnectionKind = "http" | "stdio" | "other";

export const HTTP_ADAPTER_ID = "http_mcp";
export const STDIO_ADAPTER_ID = "stdio_mcp";

export function kindForAdapter(adapterId: string): ConnectionKind {
  if (adapterId === HTTP_ADAPTER_ID) return "http";
  if (adapterId === STDIO_ADAPTER_ID) return "stdio";
  return "other";
}

/** The connection a freshly chosen transport starts from; nothing carries over from the previous one. */
export function connectionTemplate(kind: ConnectionKind): Record<string, unknown> {
  if (kind === "http") return { endpoint: "http://127.0.0.1:7001/mcp", transport: "http_streamable" };
  if (kind === "stdio") return { command: "", args: [] };
  return {};
}

export function formatConnection(connection: Record<string, unknown>): string {
  return JSON.stringify(connection, null, 2);
}

/** Parses connection JSON; null when it is not a JSON object. */
export function parseConnectionJson(json: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = json.trim() ? JSON.parse(json) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export interface ArgRow {
  id: number;
  value: string;
}

export interface EnvRow {
  id: number;
  key: string;
  value: string;
}

export interface StdioDraft {
  command: string;
  cwd: string;
  args: ArgRow[];
  env: EnvRow[];
}

let nextRowId = 1;
export function newRowId(): number {
  return nextRowId++;
}

export function draftFromConnection(connection: Record<string, unknown>): StdioDraft {
  const args = Array.isArray(connection.args) ? connection.args : [];
  const envRaw = connection.env;
  const env =
    envRaw && typeof envRaw === "object" && !Array.isArray(envRaw) ? Object.entries(envRaw as Record<string, unknown>) : [];
  return {
    command: typeof connection.command === "string" ? connection.command : "",
    cwd: typeof connection.cwd === "string" ? connection.cwd : "",
    args: args.map((value) => ({ id: newRowId(), value: String(value) })),
    env: env.map(([key, value]) => ({ id: newRowId(), key, value: String(value) }))
  };
}

/**
 * Writes the stdio fields over `base`, keeping every other key (timeoutMs, secretEnvVar, ...).
 * Blank argument rows and environment rows without a name are left out.
 */
export function connectionFromDraft(base: Record<string, unknown>, draft: StdioDraft): Record<string, unknown> {
  const next: Record<string, unknown> = { ...base, command: draft.command };
  const args = draft.args.map((row) => row.value).filter((value) => value !== "");
  if (args.length > 0) next.args = args;
  else delete next.args;
  if (draft.cwd.trim()) next.cwd = draft.cwd;
  else delete next.cwd;
  const env: Record<string, string> = {};
  for (const row of draft.env) {
    const key = row.key.trim();
    if (key) env[key] = row.value;
  }
  if (Object.keys(env).length > 0) next.env = env;
  else delete next.env;
  return next;
}

export type CommandLineResult = { ok: true; tokens: string[] } | { ok: false; error: string };

/**
 * Splits a pasted command line the way a POSIX shell would: whitespace separates words, single quotes keep
 * everything literally, double quotes allow \" and \\ escapes, and a backslash outside quotes escapes the next
 * character. Quoted empty strings ("" or '') stay as empty words.
 */
export function parseCommandLine(input: string): CommandLineResult {
  const tokens: string[] = [];
  let current = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i] as string;
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = null;
      } else if (ch === "\\" && i + 1 < input.length && (input[i + 1] === '"' || input[i + 1] === "\\")) {
        current += input[i + 1];
        i += 1;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      inWord = true;
    } else if (ch === "\\") {
      if (i + 1 >= input.length) return { ok: false, error: "The command line ends with a lone backslash." };
      current += input[i + 1];
      inWord = true;
      i += 1;
    } else if (/\s/.test(ch)) {
      if (inWord) {
        tokens.push(current);
        current = "";
        inWord = false;
      }
    } else {
      current += ch;
      inWord = true;
    }
  }
  if (quote) return { ok: false, error: `The command line has an unclosed ${quote === '"' ? "double" : "single"} quote.` };
  if (inWord) tokens.push(current);
  return { ok: true, tokens };
}
