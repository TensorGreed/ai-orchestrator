import { OUTPUT_GROUNDING_DETECTOR_ID, outputGroundingOptionIssues } from "./detectors/output-grounding";
import { OUTPUT_SAFETY_DETECTOR_ID, outputSafetyOptionIssues } from "./detectors/output-safety";
import { OUTPUT_SCHEMA_DETECTOR_ID, outputSchemaOptionIssues } from "./detectors/output-schema";
import { OUTPUT_TOPIC_DETECTOR_ID, outputTopicOptionIssues } from "./detectors/output-topic";
import type { GuardProfile } from "./profile";
import type { GuardChannel } from "./types";

/**
 * Phase 12 coverage — the output checks (schema, topic, safety, grounding)
 * as a group: their ids, and the option checks a rule set gets when it is
 * saved, so a broken schema or a topic list naming a missing dictionary is
 * refused up front instead of failing every run.
 */

export const OUTPUT_CHECK_DETECTOR_IDS = [OUTPUT_SCHEMA_DETECTOR_ID, OUTPUT_TOPIC_DETECTOR_ID, OUTPUT_SAFETY_DETECTOR_ID, OUTPUT_GROUNDING_DETECTOR_ID] as const;
export type OutputCheckDetectorId = (typeof OUTPUT_CHECK_DETECTOR_IDS)[number];

export interface OutputCheckIssue {
  /** Dotted path in the rule set, such as `channels.final_output.detectors.2.options.schema`. */
  path: string;
  message: string;
}

/** Option problems of every output check in a rule set; empty when there are none. */
export function outputCheckOptionIssues(profile: Pick<GuardProfile, "channels" | "dictionaries">): OutputCheckIssue[] {
  const issues: OutputCheckIssue[] = [];
  for (const [channel, config] of Object.entries(profile.channels) as Array<[GuardChannel, GuardProfile["channels"][GuardChannel]]>) {
    config?.detectors.forEach((entry, index) => {
      const at = `channels.${channel}.detectors.${index}.options`;
      const found =
        entry.id === OUTPUT_SCHEMA_DETECTOR_ID
          ? outputSchemaOptionIssues(entry.options)
          : entry.id === OUTPUT_TOPIC_DETECTOR_ID
            ? outputTopicOptionIssues(entry.options, profile.dictionaries)
            : entry.id === OUTPUT_SAFETY_DETECTOR_ID
              ? outputSafetyOptionIssues(entry.options)
              : entry.id === OUTPUT_GROUNDING_DETECTOR_ID
                ? outputGroundingOptionIssues(entry.options)
                : [];
      for (const issue of found) issues.push({ path: `${at}.${issue.option}`, message: issue.message });
    });
  }
  return issues;
}

/** Secret ids the output checks' model options name (to check that each is a stored secret). */
export function outputCheckSecretRefs(profile: Pick<GuardProfile, "channels">): Array<{ path: string; secretId: string }> {
  const refs: Array<{ path: string; secretId: string }> = [];
  const visit = (value: unknown, path: string) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const secretRef = (value as Record<string, unknown>).secretRef;
    if (secretRef && typeof secretRef === "object" && typeof (secretRef as Record<string, unknown>).secretId === "string") {
      refs.push({ path: `${path}.secretRef.secretId`, secretId: (secretRef as { secretId: string }).secretId });
    }
  };
  for (const [channel, config] of Object.entries(profile.channels)) {
    config?.detectors.forEach((entry, index) => {
      if (!(OUTPUT_CHECK_DETECTOR_IDS as readonly string[]).includes(entry.id)) return;
      const at = `channels.${channel}.detectors.${index}.options`;
      visit(entry.options.model, `${at}.model`);
      const judge = entry.options.judge;
      if (judge && typeof judge === "object") visit((judge as Record<string, unknown>).model, `${at}.judge.model`);
    });
  }
  return refs;
}

/** True when a rule set runs the grounding check on this channel (so the host gathers sources for it). */
export function profilesUseGrounding(profiles: ReadonlyArray<Pick<GuardProfile, "channels">>, channel: GuardChannel): boolean {
  return profiles.some((profile) => profile.channels[channel]?.detectors.some((entry) => entry.id === OUTPUT_GROUNDING_DETECTOR_ID) === true);
}
