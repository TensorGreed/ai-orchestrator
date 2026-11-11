import { OUTPUT_GROUNDING_DETECTOR_ID, outputGroundingOptionIssues } from "./detectors/output-grounding";
import { guardModelCustomEndpoint } from "./detectors/output-model";
import { OUTPUT_SAFETY_DETECTOR_ID, outputSafetyOptionIssues } from "./detectors/output-safety";
import { OUTPUT_SCHEMA_DETECTOR_ID, outputSchemaOptionIssues } from "./detectors/output-schema";
import { OUTPUT_TOPIC_DETECTOR_ID, outputTopicOptionIssues } from "./detectors/output-topic";
import type { GuardProfile } from "./profile";
import type { GuardChannel, GuardToolContext } from "./types";

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

/** Model options of the output checks that send calls to an address of their own (`baseUrl`, endpoint fields in `extra`). */
export function outputCheckCustomEndpoints(profile: Pick<GuardProfile, "channels">): Array<{ path: string }> {
  const found: Array<{ path: string }> = [];
  for (const [channel, config] of Object.entries(profile.channels)) {
    config?.detectors.forEach((entry, index) => {
      if (!(OUTPUT_CHECK_DETECTOR_IDS as readonly string[]).includes(entry.id)) return;
      const at = `channels.${channel}.detectors.${index}.options`;
      const model = guardModelCustomEndpoint(entry.options.model);
      if (model) found.push({ path: `${at}.model.${model}` });
      const judge = entry.options.judge;
      if (judge && typeof judge === "object") {
        const judgeModel = guardModelCustomEndpoint((judge as Record<string, unknown>).model);
        if (judgeModel) found.push({ path: `${at}.judge.model.${judgeModel}` });
      }
    });
  }
  return found;
}

/** Output checks set to call a model (safety by model, semantic topics, the grounding judge). */
export function outputCheckModelUses(profile: Pick<GuardProfile, "channels">): Array<{ path: string; detectorId: string }> {
  const found: Array<{ path: string; detectorId: string }> = [];
  for (const [channel, config] of Object.entries(profile.channels)) {
    config?.detectors.forEach((entry, index) => {
      const options = entry.options ?? {};
      const at = `channels.${channel}.detectors.${index}.options`;
      if (entry.id === OUTPUT_SAFETY_DETECTOR_ID && options.mode === "model") found.push({ path: `${at}.mode`, detectorId: entry.id });
      if (entry.id === OUTPUT_TOPIC_DETECTOR_ID && options.mode === "semantic") found.push({ path: `${at}.mode`, detectorId: entry.id });
      if (entry.id === OUTPUT_GROUNDING_DETECTOR_ID && (options.judge === true || (options.judge && typeof options.judge === "object"))) found.push({ path: `${at}.judge`, detectorId: entry.id });
    });
  }
  return found;
}

const WHOLE_ANSWER_CATEGORIES: Record<string, string> = { [OUTPUT_SCHEMA_DETECTOR_ID]: "schema_violation", [OUTPUT_GROUNDING_DETECTOR_ID]: "ungrounded" };

/**
 * True when a rule set stops an answer on this channel with a whole-answer check (schema, grounding): such a check
 * only runs once the answer is complete, so a streamed answer must be held back until then for the block to work.
 * Shadow rules and rules that let the answer through do not count.
 */
export function profileBlocksOnWholeAnswer(profile: Pick<GuardProfile, "channels" | "shadow">, channel: GuardChannel): boolean {
  const config = profile.channels[channel];
  if (!config) return false;
  return config.detectors.some((entry) => {
    const category = WHOLE_ANSWER_CATEGORIES[entry.id];
    if (!category) return false;
    const rule = config.actions[category] ?? config.defaultAction;
    const shadow = rule.shadow ?? profile.shadow?.[rule.action] ?? false;
    return !shadow && rule.action !== "allow";
  });
}

/** True when a rule set runs the grounding check on this channel (so the host gathers sources for it). */
export function profilesUseGrounding(profiles: ReadonlyArray<Pick<GuardProfile, "channels">>, channel: GuardChannel): boolean {
  return profiles.some((profile) => profile.channels[channel]?.detectors.some((entry) => entry.id === OUTPUT_GROUNDING_DETECTOR_ID) === true);
}

const RETRIEVAL_TOOL = /retriev|knowledge|vector|rag(?:$|[^a-z])|(?:doc|document|file|kb|note)s?[-_. ]?(?:search|lookup|query|get|read)|(?:search|lookup|query|get|read)[-_. ]?(?:doc|document|file|kb|knowledge|note)s?/i;
const OPEN_WORLD_TOOL = /web|browse|http|url|internet|google|bing|crawl|scrape/i;

/**
 * Phase 12 coverage — a tool whose answer is a document an agent's answer can be grounded in: its name says it
 * retrieves from a knowledge base or document store, and it is not marked (or named) as reaching the open web.
 */
export function isRetrievalTool(tool: Pick<GuardToolContext, "toolName" | "annotations"> | undefined): boolean {
  if (!tool) return false;
  if (tool.annotations?.openWorldHint === true) return false;
  return RETRIEVAL_TOOL.test(tool.toolName) && !OPEN_WORLD_TOOL.test(tool.toolName);
}
