/** A small argument parser: `--flag value`, `--flag=value`, repeatable flags and booleans. */
export interface ParsedArgs {
  positionals: string[];
  values: Map<string, string[]>;
  booleans: Set<string>;
}

export class UsageError extends Error {}

export function parseArgs(argv: string[], booleanFlags: string[]): ParsedArgs {
  const positionals: string[] = [];
  const values = new Map<string, string[]>();
  const booleans = new Set<string>();
  const booleanSet = new Set(booleanFlags);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
    if (booleanSet.has(name)) {
      booleans.add(name);
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
  return { positionals, values, booleans };
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
