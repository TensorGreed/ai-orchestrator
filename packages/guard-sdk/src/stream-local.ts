import type { ActionRule, GuardProfile } from "./profile";
import type { GuardRegistry } from "./registry";
import type { GuardChannel } from "./types";

/**
 * Phase 12 coverage — whether a streamed answer may be rewritten part by part
 * on `channel` (windowed streaming) instead of being generated in full first.
 *
 * - `none`: no non-shadow redact, mask, protect or transform rule: nothing to rewrite.
 * - `window`: every such rule asked for it (`stream: "window"`), none is
 *   `protect` (a token per released part would not be the token the whole
 *   answer's check issues), none is the default action (it could catch any
 *   finding), and none can apply to a finding that is not local to a stretch
 *   of text (`GuardDetector.nonStreamLocal`), from any detector on the channel.
 *   A detector the registry does not know counts as not local.
 * - `buffer`: anything else, including any rule with `stream: "buffer"`.
 *   Rule sets written before windowed streaming keep buffering.
 */
export type ChannelStreamMode = "none" | "window" | "buffer";

const REWRITES = new Set(["redact", "mask", "protect", "transform"]);

export function channelStreamMode(profile: GuardProfile, channel: GuardChannel, registry: Pick<GuardRegistry, "get">): ChannelStreamMode {
  const config = profile.channels[channel];
  if (!config) return "none";
  const rules: Array<[string | null, ActionRule]> = [[null, config.defaultAction], ...Object.entries(config.actions)];
  if (rules.some(([, rule]) => rule.stream === "buffer")) return "buffer";
  const rewrites = (rule: ActionRule) => !(rule.shadow ?? profile.shadow[rule.action] ?? false) && REWRITES.has(rule.action);
  const rewriting = rules.filter(([, rule]) => rewrites(rule));
  if (rewriting.length === 0) return "none";
  for (const [key, rule] of rewriting) {
    if (key === null || rule.stream !== "window" || rule.action === "protect") return "buffer";
  }
  // The rule a finding of `key` (data class or category) gets, as evaluation picks it.
  const ruleFor = (dataClass: string | undefined, category: string): ActionRule =>
    (dataClass ? config.actions[dataClass] : undefined) ?? config.actions[category] ?? config.defaultAction;
  for (const entry of config.detectors) {
    const detector = registry.get(entry.id);
    if (!detector) return "buffer";
    const nonLocal = detector.nonStreamLocal;
    if (!nonLocal) continue;
    if (nonLocal === true) {
      if (detector.categories.some((category) => rewrites(ruleFor(undefined, category)))) return "buffer";
      continue;
    }
    for (const key of nonLocal) {
      if (rewrites(config.actions[key] ?? config.defaultAction)) return "buffer";
      if (!config.actions[key] && detector.categories.some((category) => rewrites(ruleFor(key, category)))) return "buffer";
    }
  }
  return "window";
}
