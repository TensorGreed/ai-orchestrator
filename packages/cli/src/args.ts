/** A small argument parser: `--flag value`, `--flag=value`, repeatable flags and booleans. */
export interface ParsedArgs {
  positionals: string[];
  values: Map<string, string[]>;
  booleans: Set<string>;
  /** Flags that are neither a known boolean nor a known value flag (only when `valueFlags` is given). */
  unknown: string[];
}

export class UsageError extends Error {}

/**
 * `valueFlags`, when given, lists every flag that takes a value: any other
 * `--name` is recorded in `unknown` and does not consume the next word, so a
 * typo cannot swallow an argument. A boolean flag never takes `=value`
 * (`--sign=false` would otherwise read as true).
 */
export function parseArgs(argv: string[], booleanFlags: string[], valueFlags?: string[]): ParsedArgs {
  const positionals: string[] = [];
  const values = new Map<string, string[]>();
  const booleans = new Set<string>();
  const unknown: string[] = [];
  const booleanSet = new Set(booleanFlags);
  const valueSet = valueFlags ? new Set(valueFlags) : null;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "-o") {
      // The one short flag: -o <file> is --out <file>.
      const value = argv[index + 1];
      if (value === undefined) throw new UsageError("-o needs a file");
      values.set("out", [...(values.get("out") ?? []), value]);
      index += 1;
      continue;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
    if (booleanSet.has(name)) {
      if (eq >= 0) throw new UsageError(`--${name} is a switch and takes no value (got ${JSON.stringify(arg.slice(0, 60))}); leave it out to turn it off`);
      booleans.add(name);
      continue;
    }
    if (valueSet && !valueSet.has(name)) {
      unknown.push(name);
      continue;
    }
    let value: string | undefined;
    if (eq >= 0) {
      value = arg.slice(eq + 1);
    } else {
      value = argv[index + 1];
      index += 1;
    }
    if (value === undefined || (eq < 0 && value.startsWith("--"))) throw new UsageError(`--${name} needs a value`);
    values.set(name, [...(values.get(name) ?? []), value]);
  }
  return { positionals, values, booleans, unknown };
}

/** The flags one command accepts. */
export interface CommandFlags {
  values: readonly string[];
  booleans: readonly string[];
}

/** Refuses any flag the command does not take (a typo, or a flag of another command): exit 2 rather than a run with other settings. */
export function checkCommandFlags(args: ParsedArgs, command: string, allowed: CommandFlags): void {
  const values = new Set(allowed.values);
  const booleans = new Set([...allowed.booleans, "help"]);
  const wrong = [
    ...args.unknown,
    ...[...args.values.keys()].filter((name) => !values.has(name)),
    ...[...args.booleans].filter((name) => !booleans.has(name))
  ];
  if (wrong.length > 0) {
    const unique = [...new Set(wrong)];
    throw new UsageError(`Unknown flag${unique.length === 1 ? "" : "s"} for ${command}: ${unique.map((name) => `--${name}`).join(", ")}`);
  }
}

/** Every value of a repeatable flag, with comma-separated lists split. */
export function listFlag(args: ParsedArgs, name: string): string[] {
  return (args.values.get(name) ?? [])
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}

export function oneFlag(args: ParsedArgs, name: string): string | undefined {
  const all = args.values.get(name);
  return all && all.length > 0 ? all[all.length - 1] : undefined;
}

/** Split a command line into words, honouring single and double quotes. */
export function splitCommand(command: string): string[] {
  const words: string[] = [];
  let current = "";
  let quote: string | null = null;
  let started = false;
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started || current) words.push(current);
      current = "";
      started = false;
    } else {
      current += char;
    }
  }
  if (quote) throw new UsageError("Unterminated quote in --stdio command");
  if (started || current) words.push(current);
  return words;
}
