import { isIPv6 } from "node:net";
import type { GuardSpan } from "../types";

/**
 * IP addresses (data class `ip_address`), IPv4 and IPv6. An opt-in class: the data scan runs it only when a rule set
 * (detector option `include`) or a caller asks for it, so the built-in rule set does not change.
 *
 * Kept simple and conservative:
 * - IPv4: four dot-separated octets 0–255 without leading zeros, not part of a longer dotted or word run;
 * - version strings are skipped: a `v` or the word version (or `ver`, `release`, `build`) just before, or a
 *   pre-release / build suffix (`-beta`, `+build`) just after;
 * - IPv6: colon groups of hex that Node accepts as an IPv6 address (an embedded IPv4 tail included), with at least two
 *   colons; times such as `12:30:45` are not addresses.
 */

const IPV4 = /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w]|\.\d)/g;
// Bounded quantifiers only: no catastrophic backtracking on long colon or hex runs.
const IPV6 = /(?<![\w:.])(?:[0-9A-Fa-f]{0,4}:){2,7}(?:(?:\d{1,3}\.){3}\d{1,3}|[0-9A-Fa-f]{1,4})?(?![\w:]|\.\d)/g;
const VERSION_BEFORE = /(?:\bv|\bversions?\s*[:=]?\s*v?|\bver\.?\s*v?|\breleases?\s*v?|\bbuild\s*v?)$/i;
const VERSION_AFTER = /^(?:-[A-Za-z]|\+[\w])/;

function octetsValid(value: string): boolean {
  return value.split(".").every((octet) => octet.length > 0 && Number(octet) <= 255 && (octet.length === 1 || octet[0] !== "0"));
}

function versionContext(text: string, start: number, end: number): boolean {
  return VERSION_BEFORE.test(text.slice(Math.max(0, start - 12), start)) || VERSION_AFTER.test(text.slice(end, end + 2));
}

/** Spans of IP addresses in `text`, in order. */
export function findIpAddressSpans(text: string): GuardSpan[] {
  const spans: GuardSpan[] = [];
  for (const match of text.matchAll(IPV6)) {
    const value = match[0];
    const start = match.index ?? 0;
    if (!/[0-9A-Fa-f]/.test(value) || !isIPv6(value)) continue;
    spans.push({ start, end: start + value.length });
  }
  const v6 = [...spans];
  for (const match of text.matchAll(IPV4)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (!octetsValid(match[0]) || versionContext(text, start, end)) continue;
    // The IPv4 tail of an IPv6 address (`::ffff:10.0.0.1`) is part of that address.
    if (v6.some((span) => span.start <= start && span.end >= end)) continue;
    spans.push({ start, end });
  }
  return spans.sort((a, b) => a.start - b.start);
}
