import { excerptEvidence } from "../masking";
import type { DetectorContext, GuardDetector, GuardFinding, GuardInput, GuardSpan } from "../types";
import { clampScore } from "../types";

export const COMMAND_GUARD_DETECTOR_ID = "tool.command";
export const CODE_GUARD_DETECTOR_ID = "tool.code";

/**
 * Phase 12.3 — command guard: shell metacharacters in command strings,
 * argument injection (option-shaped values from untrusted input) and static
 * checks on code-node source.
 */

export interface CommandIssue {
  code: "shell_metacharacter" | "command_substitution" | "redirection" | "argument_injection" | "dangerous_command";
  score: number;
  message: string;
  span: GuardSpan;
}

const META: Array<{ pattern: RegExp; code: CommandIssue["code"]; score: number; message: string }> = [
  { pattern: /\$\([^)]*\)|`[^`]*`/g, code: "command_substitution", score: 0.95, message: "Command substitution" },
  { pattern: /\$\{[^}]*\}/g, code: "command_substitution", score: 0.6, message: "Shell parameter expansion" },
  { pattern: /(?<![&|])(?:&&|\|\||;|\|)(?![&|])/g, code: "shell_metacharacter", score: 0.85, message: "Command chaining or pipe" },
  { pattern: /(?:^|\s)(?:\d?>>?|<<?|>&|&>)\s*\S/g, code: "redirection", score: 0.8, message: "Shell redirection" },
  { pattern: /(?:^|\s)&\s*$/g, code: "shell_metacharacter", score: 0.5, message: "Background execution" },
  { pattern: /\n/g, code: "shell_metacharacter", score: 0.7, message: "Newline inside a command string" }
];

const DANGEROUS_COMMANDS =
  /(?:^|[\s;&|(`])(?:rm\s+(?:-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b[^;&|]*(?:\s\/(?:\s|$)|\s~|\s\*|\s\$HOME)|mkfs(?:\.\w+)?\b|dd\s+if=|:\(\)\s*\{\s*:\|:&\s*\};:|chmod\s+(?:-R\s+)?[0-7]*777\s+\/|curl\b[^|]*\|\s*(?:ba|z|da)?sh\b|wget\b[^|]*\|\s*(?:ba|z|da)?sh\b|shutdown\b|reboot\b|nc\s+(?:-[a-z]*e|-[a-z]*l[a-z]*p)\b|\/dev\/tcp\/)/gi;

/** Scan a command line for metacharacters, substitutions, redirections and dangerous commands. */
export function scanCommand(command: string): CommandIssue[] {
  const issues: CommandIssue[] = [];
  const ranges = quotedRanges(command);
  const inSingleQuotes = (index: number) => ranges.some((r) => r.quote === "'" && index > r.start && index < r.end);
  for (const rule of META) {
    rule.pattern.lastIndex = 0;
    for (const match of command.matchAll(rule.pattern)) {
      const start = match.index ?? 0;
      // Single quotes neutralise metacharacters in POSIX shells; double quotes do not neutralise `$(` or backticks.
      if (inSingleQuotes(start)) continue;
      issues.push({ code: rule.code, score: rule.score, message: rule.message, span: { start, end: start + match[0].length } });
    }
  }
  DANGEROUS_COMMANDS.lastIndex = 0;
  for (const match of command.matchAll(DANGEROUS_COMMANDS)) {
    const start = match.index ?? 0;
    issues.push({ code: "dangerous_command", score: 0.95, message: "Destructive or remote-execution command", span: { start, end: start + match[0].length } });
  }
  return issues;
}

function quotedRanges(command: string): Array<{ quote: string; start: number; end: number }> {
  const ranges: Array<{ quote: string; start: number; end: number }> = [];
  let i = 0;
  while (i < command.length) {
    const c = command[i]!;
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      const end = command.indexOf(c, i + 1);
      if (end < 0) break;
      ranges.push({ quote: c, start: i, end });
      i = end + 1;
      continue;
    }
    i += 1;
  }
  return ranges;
}

/**
 * Argument injection: a value that should be data but starts with `-` is
 * read as an option by most programs (`--output=/etc/passwd`, `-rf`). Values
 * are flagged when they come from untrusted input, or always when
 * `untrustedOnly` is false. The literal `-` (stdin) is fine.
 */
export function scanArgumentInjection(args: readonly string[], untrustedIndexes?: ReadonlySet<number>): Array<{ index: number; score: number; message: string }> {
  const issues: Array<{ index: number; score: number; message: string }> = [];
  let afterDoubleDash = false;
  args.forEach((arg, index) => {
    if (arg === "--") {
      afterDoubleDash = true;
      return;
    }
    if (afterDoubleDash) return;
    if (untrustedIndexes && !untrustedIndexes.has(index)) return;
    if (/^-{1,2}[A-Za-z0-9]/.test(arg) && arg !== "-") {
      issues.push({ index, score: untrustedIndexes ? 0.9 : 0.6, message: `Argument ${index} is option-shaped${untrustedIndexes ? " and comes from untrusted input" : ""}` });
    }
  });
  return issues;
}

export function createCommandGuardDetector(): GuardDetector {
  return {
    id: COMMAND_GUARD_DETECTOR_ID,
    tier: "rule",
    description: "Shell metacharacters, command substitution, redirection, destructive commands and option-shaped arguments from untrusted input.",
    channels: ["tool_arguments"],
    categories: ["command_injection"],
    detect(input: GuardInput, context: DetectorContext) {
      const findings: GuardFinding[] = [];
      const keys = new Set(Array.isArray(context.options.commandKeys) ? (context.options.commandKeys as string[]) : ["command", "cmd", "shell", "script", "bash", "sh", "exec", "run"]);
      const argKeys = new Set(Array.isArray(context.options.argumentKeys) ? (context.options.argumentKeys as string[]) : ["args", "argv", "arguments"]);
      const untrustedPaths = new Set(input.tool?.untrustedArguments ?? []);
      const untrustedContent = input.labels?.includes("untrusted_external") === true;
      const addCommand = (command: string, path: string) => {
        for (const issue of scanCommand(command)) {
          const span = locate(context.text, command, issue.span);
          findings.push({
            detectorId: COMMAND_GUARD_DETECTOR_ID,
            category: "command_injection",
            score: clampScore(issue.score),
            spans: [span],
            evidence: excerptEvidence(context.text, span),
            message: issue.message,
            metadata: { code: issue.code, path }
          });
        }
      };
      if (typeof input.content === "string") {
        addCommand(input.content, "");
        return findings;
      }
      const visit = (value: unknown, path: string, key: string) => {
        if (typeof value === "string") {
          if (keys.has(key) || (path === "" && keys.size === 0)) addCommand(value, path);
          return;
        }
        if (Array.isArray(value)) {
          if (argKeys.has(key) && value.every((v) => typeof v === "string")) {
            const untrusted = untrustedContent
              ? new Set(value.map((_, i) => i))
              : new Set(value.map((_, i) => i).filter((i) => untrustedPaths.has(`${path}[${i}]`) || untrustedPaths.has(path)));
            // Without provenance every option-shaped argument would be flagged, so only untrusted values are checked.
            if (untrusted.size === 0) {
              value.forEach((item, index) => visit(item, `${path}[${index}]`, key));
              return;
            }
            for (const issue of scanArgumentInjection(value as string[], untrusted)) {
              const arg = value[issue.index] as string;
              const span = locate(context.text, arg, { start: 0, end: arg.length });
              findings.push({
                detectorId: COMMAND_GUARD_DETECTOR_ID,
                category: "command_injection",
                score: clampScore(issue.score),
                spans: [span],
                evidence: excerptEvidence(context.text, span),
                message: issue.message,
                metadata: { code: "argument_injection", path: `${path}[${issue.index}]` }
              });
            }
          }
          value.forEach((item, index) => visit(item, `${path}[${index}]`, key));
          return;
        }
        if (value && typeof value === "object") {
          for (const [k, inner] of Object.entries(value as Record<string, unknown>)) visit(inner, path ? `${path}.${k}` : k, k);
        }
      };
      visit(input.content, "", "");
      return findings;
    }
  };
}

/** Map a span inside `needle` to a span in `text` (the JSON serialisation), falling back to the whole text. */
function locate(text: string, needle: string, inner: GuardSpan): GuardSpan {
  const direct = text.indexOf(needle);
  if (direct >= 0) return { start: direct + inner.start, end: direct + inner.end };
  const encoded = JSON.stringify(needle).slice(1, -1);
  const at = text.indexOf(encoded);
  if (at >= 0) {
    const prefix = JSON.stringify(needle.slice(0, inner.start)).slice(1, -1).length;
    const length = JSON.stringify(needle.slice(inner.start, inner.end)).slice(1, -1).length;
    return { start: at + prefix, end: at + prefix + length };
  }
  return { start: 0, end: text.length };
}

// Static checks on code-node source

export type CodeLanguage = "python" | "javascript";

export interface CodeRule {
  id: string;
  language: CodeLanguage | "any";
  pattern: RegExp;
  score: number;
  message: string;
}

export const DEFAULT_CODE_RULES: CodeRule[] = [
  { id: "py-subprocess", language: "python", pattern: /^\s*(?:import\s+subprocess|from\s+subprocess\s+import)\b|\bsubprocess\.(?:run|call|Popen|check_output|check_call)\s*\(/gm, score: 0.9, message: "Spawns processes (subprocess)" },
  { id: "py-os-system", language: "python", pattern: /\bos\.(?:system|popen|exec[lv]p?e?|spawn[lv]p?e?|remove|unlink|rmdir|removedirs|kill|killpg)\s*\(/g, score: 0.9, message: "Runs commands or removes files through os" },
  { id: "py-eval", language: "python", pattern: /(?<![\w.])(?:eval|exec|compile)\s*\(/g, score: 0.85, message: "Dynamic code execution" },
  { id: "py-import", language: "python", pattern: /\b__import__\s*\(|\bimportlib\.import_module\s*\(/g, score: 0.8, message: "Dynamic import" },
  { id: "py-pickle", language: "python", pattern: /\bpickle\.loads?\s*\(|\bmarshal\.loads?\s*\(|\byaml\.(?:load|unsafe_load)\s*\((?![^)]*SafeLoader)/g, score: 0.8, message: "Unsafe deserialisation" },
  { id: "py-network", language: "python", pattern: /^\s*(?:import\s+(?:socket|ctypes|ftplib|telnetlib|smtplib)|from\s+(?:socket|ctypes|ftplib|telnetlib|smtplib)\s+import)\b/gm, score: 0.7, message: "Raw network or native access" },
  { id: "py-shutil", language: "python", pattern: /\bshutil\.(?:rmtree|move)\s*\(/g, score: 0.7, message: "Removes or moves directory trees" },
  { id: "py-dunder", language: "python", pattern: /\.__(?:subclasses|globals|builtins|class|bases|mro|code)__\b/g, score: 0.8, message: "Introspection used to escape sandboxes" },
  { id: "js-child-process", language: "javascript", pattern: /\brequire\s*\(\s*["'](?:node:)?child_process["']\s*\)|\bfrom\s+["'](?:node:)?child_process["']|\bimport\s*\(\s*["'](?:node:)?child_process["']\s*\)/g, score: 0.9, message: "Spawns processes (child_process)" },
  { id: "js-eval", language: "javascript", pattern: /(?<![\w.])eval\s*\(|\bnew\s+Function\s*\(|\bvm\.(?:runIn\w+Context|compileFunction|Script)\b/g, score: 0.85, message: "Dynamic code execution" },
  { id: "js-process", language: "javascript", pattern: /\bprocess\.(?:binding|dlopen|_linkedBinding|kill|exit|env)\b/g, score: 0.7, message: "Process internals or environment access" },
  { id: "js-fs-destructive", language: "javascript", pattern: /\bfs(?:\.promises)?\.(?:rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync)\s*\(/g, score: 0.7, message: "Removes files" },
  { id: "js-worker", language: "javascript", pattern: /\brequire\s*\(\s*["'](?:node:)?(?:worker_threads|cluster|dgram|net|tls)["']\s*\)|\bfrom\s+["'](?:node:)?(?:worker_threads|cluster|dgram|net|tls)["']/g, score: 0.6, message: "Raw network or worker access" },
  { id: "any-reverse-shell", language: "any", pattern: /\/dev\/tcp\/|\bnc\s+-e\b|\bbash\s+-i\b/g, score: 0.95, message: "Reverse shell pattern" }
];

export interface CodeIssue {
  ruleId: string;
  score: number;
  message: string;
  span: GuardSpan;
}

export function scanCodeSource(source: string, language: CodeLanguage, rules: readonly CodeRule[] = DEFAULT_CODE_RULES): CodeIssue[] {
  const issues: CodeIssue[] = [];
  for (const rule of rules) {
    if (rule.language !== "any" && rule.language !== language) continue;
    rule.pattern.lastIndex = 0;
    for (const match of source.matchAll(rule.pattern)) {
      const start = match.index ?? 0;
      issues.push({ ruleId: rule.id, score: rule.score, message: rule.message, span: { start, end: start + match[0].length } });
    }
  }
  return issues.sort((a, b) => a.span.start - b.span.start);
}

export function createCodeGuardDetector(): GuardDetector {
  return {
    id: CODE_GUARD_DETECTOR_ID,
    tier: "rule",
    description: "Static checks on code-node source: dangerous imports and calls for Python and JavaScript.",
    channels: ["tool_arguments"],
    categories: ["unsafe_code"],
    detect(input: GuardInput, context: DetectorContext) {
      const language = context.options.language === "javascript" ? "javascript" : "python";
      const extra = Array.isArray(context.options.extraRules) ? (context.options.extraRules as Array<{ id: string; pattern: string; score?: number; message?: string; language?: CodeLanguage }>) : [];
      const disabled = new Set(Array.isArray(context.options.disableRules) ? (context.options.disableRules as string[]) : []);
      const rules: CodeRule[] = DEFAULT_CODE_RULES.filter((r) => !disabled.has(r.id));
      for (const item of extra) {
        try {
          rules.push({ id: item.id, language: item.language ?? "any", pattern: new RegExp(item.pattern, "g"), score: clampScore(item.score ?? 0.8), message: item.message ?? item.id });
        } catch {
          // Skip invalid custom rules.
        }
      }
      const sources: Array<{ source: string; path: string }> = [];
      if (typeof input.content === "string") sources.push({ source: input.content, path: "" });
      else if (input.content && typeof input.content === "object") {
        const keys = new Set(Array.isArray(context.options.sourceKeys) ? (context.options.sourceKeys as string[]) : ["code", "source", "script", "program"]);
        for (const [key, value] of Object.entries(input.content as Record<string, unknown>)) {
          if (typeof value === "string" && keys.has(key)) sources.push({ source: value, path: key });
        }
      }
      const findings: GuardFinding[] = [];
      for (const { source, path } of sources) {
        for (const issue of scanCodeSource(source, language, rules)) {
          const span = locate(context.text, source, issue.span);
          findings.push({
            detectorId: CODE_GUARD_DETECTOR_ID,
            category: "unsafe_code",
            score: clampScore(issue.score),
            spans: [span],
            evidence: excerptEvidence(context.text, span),
            message: issue.message,
            metadata: { ruleId: issue.ruleId, path, language }
          });
        }
      }
      return findings;
    }
  };
}
