import { shannonEntropy } from "../masking";
import { scrubbedExcerpt } from "./dlp";
import type { DetectorContext, GuardDetector, GuardFinding, GuardInput } from "../types";
import { clampScore } from "../types";

export const EXFILTRATION_DETECTOR_ID = "exfiltration.urls";

/**
 * Phase 12.2 — exfiltration channels. A model that was injected can leak
 * context by rendering a markdown image whose URL carries the data (the
 * client fetches it without a click), by a link the user may click, or by
 * putting an unexpected URL into a tool argument. Hosts in `allowedHosts`
 * (profile option) are exempt; on `tool_arguments` any host outside the list
 * is reported when a list is given.
 */

const MARKDOWN_IMAGE = /!\[[^\]]*\]\(\s*<?([^\s)>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const MARKDOWN_LINK = /(?<!!)\[[^\]]*\]\(\s*<?([^\s)>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const HTML_IMAGE = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
const BARE_URL = /\bhttps?:\/\/[^\s<>"'()\]]+/gi;

export interface UrlDataSignal {
  /** 0..1 how much the URL looks like it carries data. */
  score: number;
  reasons: string[];
}

export function urlDataSignal(url: string): UrlDataSignal {
  const reasons: string[] = [];
  let score = 0;
  let parsed: URL | null = null;
  try {
    parsed = new URL(url);
  } catch {
    return { score: 0, reasons: ["unparseable"] };
  }
  const query = parsed.search.slice(1);
  if (query.length > 0) {
    const values = [...parsed.searchParams.values()];
    const longValue = values.find((v) => v.length >= 24);
    if (longValue) {
      reasons.push("long query value");
      score += 0.35;
      if (shannonEntropy(longValue) > 3.8) {
        reasons.push("high-entropy query value");
        score += 0.25;
      }
    }
    if (query.length >= 80) {
      reasons.push("long query string");
      score += 0.2;
    }
    if (/(?:^|&)(?:data|q|payload|msg|message|text|content|secret|key|token|password|pwd|api[_-]?key|session|cookie|history|context|prompt|exfil|leak)=/i.test(query)) {
      reasons.push("data-like query parameter name");
      score += 0.35;
    }
    if (/%[0-9a-f]{2}%[0-9a-f]{2}%[0-9a-f]{2}/i.test(query) && query.length >= 40) {
      reasons.push("encoded text in query");
      score += 0.15;
    }
  }
  const segments = parsed.pathname.split("/").filter(Boolean).map((s) => s.replace(/\.[a-z0-9]{1,5}$/i, ""));
  const dataSegment = segments.find((s) => s.length >= 32 && /^[A-Za-z0-9+/=_-]+$/.test(s) && shannonEntropy(s) > 3.5);
  if (dataSegment) {
    reasons.push("data-like path segment");
    score += 0.35;
  }
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(parsed.hostname) || /^\[/.test(parsed.hostname)) {
    reasons.push("raw ip host");
    score += 0.15;
  }
  if (parsed.hostname.split(".").length >= 5 || parsed.hostname.length > 60) {
    reasons.push("data-like hostname");
    score += 0.25;
  }
  return { score: clampScore(score), reasons };
}

function hostAllowed(url: string, allowed: string[]): boolean {
  if (allowed.length === 0) return false;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return allowed.some((entry) => {
    const pattern = entry.toLowerCase().trim();
    if (!pattern) return false;
    if (pattern.startsWith("*.")) return host === pattern.slice(2) || host.endsWith(pattern.slice(1));
    return host === pattern;
  });
}

export function createExfiltrationDetector(): GuardDetector {
  return {
    id: EXFILTRATION_DETECTOR_ID,
    tier: "rule",
    description: "Markdown images and links whose URLs carry data, and unexpected outbound URLs in tool arguments.",
    channels: ["model_output", "final_output", "tool_arguments", "tool_result"],
    categories: ["exfiltration"],
    detect(input: GuardInput, context: DetectorContext) {
      const text = context.text;
      const allowed = Array.isArray(context.options.allowedHosts) ? (context.options.allowedHosts as string[]) : [];
      const findings: GuardFinding[] = [];
      const seen = new Set<string>();
      const push = (kind: string, url: string, start: number, end: number, base: number, reasonsExtra: string[] = []) => {
        const key = `${start}:${end}`;
        if (seen.has(key)) return;
        seen.add(key);
        if (hostAllowed(url, allowed)) return;
        const signal = urlDataSignal(url);
        const score = clampScore(base + signal.score * (1 - base));
        if (signal.score === 0 && base < 0.5) return;
        findings.push({
          detectorId: EXFILTRATION_DETECTOR_ID,
          category: "exfiltration",
          score,
          spans: [{ start, end }],
          evidence: scrubbedExcerpt(text, { start, end }, 60),
          message: `${kind}${signal.reasons.length ? ` (${[...signal.reasons, ...reasonsExtra].join(", ")})` : reasonsExtra.length ? ` (${reasonsExtra.join(", ")})` : ""}`,
          metadata: { kind, reasons: [...signal.reasons, ...reasonsExtra], host: safeHost(url) }
        });
      };
      for (const match of text.matchAll(MARKDOWN_IMAGE)) {
        const url = match[1]!;
        if (!/^https?:/i.test(url)) continue;
        // Images are fetched without a click: any external image in model output is suspect.
        push("markdown image fetching an external URL", url, match.index ?? 0, (match.index ?? 0) + match[0].length, 0.5);
      }
      for (const match of text.matchAll(HTML_IMAGE)) {
        const url = match[1]!;
        if (!/^https?:/i.test(url)) continue;
        push("html image fetching an external URL", url, match.index ?? 0, (match.index ?? 0) + match[0].length, 0.5);
      }
      for (const match of text.matchAll(MARKDOWN_LINK)) {
        const url = match[1]!;
        if (!/^https?:/i.test(url)) continue;
        push("markdown link carrying data", url, match.index ?? 0, (match.index ?? 0) + match[0].length, 0.2);
      }
      for (const match of text.matchAll(BARE_URL)) {
        const url = match[0];
        const start = match.index ?? 0;
        const end = start + url.length;
        // A URL inside a markdown image or link was handled above.
        if (findings.some((f) => f.spans.some((s) => s.start <= start && s.end >= end))) continue;
        if ([...seen].some((key) => { const [s, e] = key.split(":").map(Number); return s! <= start && e! >= end; })) continue;
        if (input.channel === "tool_arguments" && allowed.length > 0 && !hostAllowed(url, allowed)) {
          push("outbound URL to a host outside the allowlist", url, start, end, 0.7, ["host not allowlisted"]);
          continue;
        }
        push("URL carrying data", url, start, end, 0.1);
      }
      return findings;
    }
  };
}

function safeHost(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}
