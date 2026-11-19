import type { LegacyBehaviour } from "@ai-orchestrator/shared";

// The rules live in the shared package, so the workflow builder and the starter templates apply the same ones.
export { behavioursOffDefault, legacyBehaviours, restoreOldBehaviour, upgradeToNewBehaviour, type LegacyBehaviour } from "@ai-orchestrator/shared";

const DESCRIPTIONS: Record<LegacyBehaviour, string> = {
  loop_collect: "it does not collect each pass's results",
  loop_route: "IF, Switch and Filter in its body do not route on each pass",
  http_fail: "an HTTP error status does not always fail it",
  filter_gate: "it passes or stops the whole input instead of keeping the matching items of a list",
  set_text: "fields saved without a type turn their values into text"
};

/** What the newer behaviour changes, so the user can check the nodes after it. */
const UPGRADE_NOTES: Record<LegacyBehaviour, string> = {
  loop_collect: "Its output gets collected, one entry per pass.",
  loop_route: "The nodes on a body node's outputs then run once per item.",
  http_fail: "A 4xx or 5xx then fails the node, so retries and the Error output apply.",
  filter_gate: "Its conditions then read each item's fields.",
  set_text: "Those fields then keep the type of a {{ }} value (Auto)."
};

/** One line on what the node keeps from before, for the notice above its form. */
export function legacySummary(behaviours: LegacyBehaviour[]): string {
  const parts = behaviours.map((behaviour) => DESCRIPTIONS[behaviour]);
  const joined = parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
  return `Saved with an earlier behaviour: ${joined}.`;
}

/** What upgrading changes, one sentence per behaviour. */
export function upgradeNotes(behaviours: LegacyBehaviour[]): string {
  return behaviours.map((behaviour) => UPGRADE_NOTES[behaviour]).join(" ");
}
