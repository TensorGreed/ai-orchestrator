import { ENTITIES_DETECTOR_ID, GUARD_REDACT_PERSONAL_DATA_PROFILE_ID } from "@ai-orchestrator/shared";
import { DEFAULT_GUARD_PROFILE_DOCUMENT } from "./default-profile";
import { parseGuardProfile, type GuardProfile, type GuardProfileInput } from "./profile";

/**
 * The built-in "Redact personal data" rule set: the default rule set, plus person names and street addresses (the
 * `data.entities` detector: the deployment's names and addresses service when one is configured, otherwise the
 * built-in rules), with personal data (emails, phone numbers, names, addresses, account and ID numbers) redacted
 * instead of allowed wherever text is checked: prompts, tool results, model output and the final answer. Card numbers
 * stay masked and credentials redacted, as in the default. It runs only where it is picked (a Content Rules node's
 * rule set, or a binding); nothing changes for workflows that do not pick it.
 */

export const REDACT_PERSONAL_DATA_PROFILE_ID = GUARD_REDACT_PERSONAL_DATA_PROFILE_ID;
export const REDACT_PERSONAL_DATA_PROFILE_NAME = "Redact personal data";

/** Classes of the entity detector the preset turns on (locations alone, such as a city, are not personal data). */
export const REDACT_PERSONAL_DATA_ENTITY_CLASSES = ["person_name", "street_address"] as const;

type ChannelDocument = NonNullable<NonNullable<GuardProfileInput["channels"]>["prompt"]>;

const ENTITY_DETECTOR = { id: ENTITIES_DETECTOR_ID, threshold: 0.5, options: { classes: [...REDACT_PERSONAL_DATA_ENTITY_CLASSES] } };

/** The default channel with names and addresses found, and personal data redacted. */
function redacting(channel: ChannelDocument): ChannelDocument {
  return {
    ...channel,
    detectors: [...(channel.detectors ?? []), ENTITY_DETECTOR],
    actions: { ...(channel.actions ?? {}), sensitive_data: { action: "redact" } }
  };
}

const defaults = DEFAULT_GUARD_PROFILE_DOCUMENT.channels ?? {};

export const REDACT_PERSONAL_DATA_PROFILE_DOCUMENT: GuardProfileInput = {
  ...DEFAULT_GUARD_PROFILE_DOCUMENT,
  id: REDACT_PERSONAL_DATA_PROFILE_ID,
  name: REDACT_PERSONAL_DATA_PROFILE_NAME,
  version: "1",
  description:
    "The default rule set, and it also redacts personal data: names, email addresses, phone numbers, street addresses, and account and ID numbers.",
  channels: {
    ...defaults,
    prompt: redacting(defaults.prompt!),
    tool_result: redacting(defaults.tool_result!),
    model_output: redacting(defaults.model_output!),
    final_output: redacting(defaults.final_output!)
  }
};

export function createRedactPersonalDataProfile(): GuardProfile {
  return parseGuardProfile(REDACT_PERSONAL_DATA_PROFILE_DOCUMENT);
}
