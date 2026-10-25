import {
  DESTINATION_TIER_LABELS,
  destinationTierExceeds,
  regionAllowed,
  type DataLabels,
  type ProvenanceLabel,
  type ResolvedDestination
} from "@ai-orchestrator/shared";
import type { DestinationRuleAction, GuardProfile } from "./profile";
import { SURROGATE_EMAIL_DOMAIN } from "./protection/surrogate";
import type { GuardAction, GuardSpan } from "./types";

/**
 * Phase 16 — destination rules, evaluated as a pure function. The caller
 * (the engine, later) knows where a call goes (`ResolvedDestination` from
 * shared `resolveDestination`), what the scan of the outgoing content found
 * and the labels the data carries; this decides which of the profile's
 * destination rules fire. Nothing here sends, blocks or rewrites anything.
 */

/** Said in a verdict when a rule fired on a label alone: there is nothing in the text to rewrite. */
export const LABEL_ONLY_REASON = "matched by where the data came from, not found in the text";

export interface DestinationRuleInput {
  labels: DataLabels;
  /** Data classes the scan found in the outgoing content (issued surrogates already dropped). */
  foundClasses: readonly string[];
  destination: ResolvedDestination;
}

export interface FiredDestinationRule {
  ruleIndex: number;
  dataClass?: string;
  provenance?: ProvenanceLabel;
  /** The action that takes effect (after the label-only fallback). */
  action: GuardAction;
  /** The action the rule asked for. */
  requestedAction: DestinationRuleAction;
  shadow: boolean;
  /** `content`: the scan found the class in the text. `labels`: only the data's labels carry it. */
  basis: "content" | "labels";
  /** Plain-language reason, never a value. */
  reason: string;
}

export interface DestinationRuleResult {
  fired: FiredDestinationRule[];
}

const REWRITING_ACTIONS: ReadonlySet<string> = new Set(["redact", "mask", "protect"]);

/** True when the profile has destination rules to evaluate. */
export function profileHasDestinationRules(profile: Pick<GuardProfile, "destinations">): boolean {
  return (profile.destinations?.rules.length ?? 0) > 0;
}

/** Fallbacks that still stop the data: anything else (allow, review, a rewrite) would let it leave. */
const STOPPING_ACTIONS: ReadonlySet<GuardAction> = new Set<GuardAction>(["block", "require_approval"]);

/**
 * What a label-only finding gets instead of redact, mask or protect: the
 * profile's protection fallback when that still stops the data (block or
 * require approval), otherwise block. A rule written to keep data in must
 * never degrade into letting it out.
 */
function labelOnlyAction(profile: GuardProfile): GuardAction {
  const fallback = profile.protection.fallback;
  return STOPPING_ACTIONS.has(fallback) ? fallback : "block";
}

/** Region conditions apply only to vendor and public destinations; local and private are home and always pass. */
function regionChecked(destination: ResolvedDestination): boolean {
  return destination.tier === "vendor" || destination.tier === "public";
}

function describeDestination(destination: ResolvedDestination): string {
  const tier = DESTINATION_TIER_LABELS[destination.tier].toLowerCase();
  const name = destination.name ? `${destination.name} (${tier})` : tier;
  return destination.region && destination.region !== "unknown" ? `${name}, region ${destination.region}` : name;
}

/**
 * The profile's destination rules that fire for data going to `destination`.
 * A rule fires when the data matches its `when` (any listed class or
 * provenance label; no condition means any data) and the destination is
 * outside its `allow` (a tier further out than `maxTier`, or, for vendor and
 * public destinations only, a region not covered; local and private
 * destinations always pass a region check). Classes are the scan's findings
 * plus the labels' classes; a destination approved to hold a class lets that
 * class through. A class only the labels carry cannot be rewritten, so
 * redact, mask and protect become the profile's protection fallback when
 * that is block or require approval, and block otherwise.
 */
export function evaluateDestinationRules(profile: GuardProfile, input: DestinationRuleInput): DestinationRuleResult {
  const rules = profile.destinations?.rules ?? [];
  const fired: FiredDestinationRule[] = [];
  if (rules.length === 0) return { fired };
  const found = new Set(input.foundClasses);
  const classes = new Set([...input.foundClasses, ...input.labels.dataClasses]);
  const provenance = new Set(input.labels.provenance);
  const held = new Set(input.destination.holdsDataClasses);
  const where = describeDestination(input.destination);

  rules.forEach((rule, ruleIndex) => {
    const tierBroken = destinationTierExceeds(input.destination.tier, rule.allow.maxTier);
    const regionBroken =
      Boolean(rule.allow.regions?.length) && regionChecked(input.destination) && !regionAllowed(input.destination.region, rule.allow.regions!);
    if (!tierBroken && !regionBroken) return;
    const limit = tierBroken
      ? `may go no further than ${DESTINATION_TIER_LABELS[rule.allow.maxTier].toLowerCase()}`
      : `may only go to regions ${rule.allow.regions!.join(", ")}`;
    const label = rule.name ? `Rule "${rule.name}": ` : "";

    const push = (entry: { dataClass?: string; provenance?: ProvenanceLabel; basis: "content" | "labels"; subject: string }) => {
      const labelOnly = entry.basis === "labels" && REWRITING_ACTIONS.has(rule.action);
      const action: GuardAction = labelOnly ? labelOnlyAction(profile) : rule.action;
      const shadow = rule.shadow ?? profile.shadow[action] ?? false;
      const because = entry.basis === "labels" ? `; ${LABEL_ONLY_REASON}` : "";
      fired.push({
        ruleIndex,
        ...(entry.dataClass !== undefined ? { dataClass: entry.dataClass } : {}),
        ...(entry.provenance !== undefined ? { provenance: entry.provenance } : {}),
        action,
        requestedAction: rule.action,
        shadow,
        basis: entry.basis,
        reason: `${label}${entry.subject} ${limit}; this destination is ${where}${because}`
      });
    };

    const whenClasses = rule.when.dataClasses ?? [];
    const whenProvenance = rule.when.provenance ?? [];
    if (whenClasses.length === 0 && whenProvenance.length === 0) {
      push({ basis: "content", subject: "Outgoing data" });
      return;
    }
    for (const dataClass of whenClasses) {
      if (!classes.has(dataClass) || held.has(dataClass)) continue;
      push({ dataClass, basis: found.has(dataClass) ? "content" : "labels", subject: `Data of class ${dataClass}` });
    }
    for (const origin of whenProvenance) {
      if (!provenance.has(origin)) continue;
      push({ provenance: origin, basis: "labels", subject: `Data labelled ${origin}` });
    }
  });
  return { fired };
}

// ---------------------------------------------------------------------------
// Issued surrogates
// ---------------------------------------------------------------------------

/** True for an email address at the surrogate domain (`…@surrogate.invalid`), whoever issued it. */
export function isSurrogateEmail(value: string): boolean {
  const text = value.trim().toLowerCase();
  const at = text.lastIndexOf("@");
  return at > 0 && text.slice(at + 1) === SURROGATE_EMAIL_DOMAIN;
}

/** A scan match: a DLP match (`span`), a guard finding (`spans`) or anything carrying its matched `value`. */
export interface SurrogateCandidate {
  dataClass?: string;
  value?: string;
  span?: GuardSpan;
  spans?: readonly GuardSpan[];
}

function matchedValues(match: SurrogateCandidate, text: string | undefined): string[] | undefined {
  if (typeof match.value === "string") return [match.value];
  if (text === undefined) return undefined;
  const spans = match.spans?.length ? match.spans : match.span ? [match.span] : [];
  if (spans.length === 0) return undefined;
  return spans.map((span) => text.slice(span.start, span.end));
}

function isIssued(value: string, dataClass: string | undefined, issued: ReadonlySet<string>): boolean {
  const trimmed = value.trim();
  if (issued.has(trimmed)) return true;
  if (dataClass === undefined || dataClass === "email") {
    if (isSurrogateEmail(trimmed)) return true;
    if (issued.has(trimmed.toLowerCase())) return true;
  }
  return false;
}

/**
 * Scan matches without the ones that are surrogates this run issued (or any
 * `@surrogate.invalid` email): a surrogate stands in for a value that never
 * left, so the destination check and the egress scan must not count it.
 * Pass the scanned `text` when the matches carry spans rather than values; a
 * match whose value cannot be read is kept.
 */
export function dropIssuedSurrogates<T extends SurrogateCandidate>(matches: readonly T[], issued: ReadonlySet<string>, text?: string): T[] {
  return matches.filter((match) => {
    const values = matchedValues(match, text);
    if (!values) return true;
    return !values.every((value) => isIssued(value, match.dataClass, issued));
  });
}
