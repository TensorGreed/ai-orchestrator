/**
 * The settings a NEW node starts with, wherever it is created (the editor's palette, Describe it). It is the node
 * catalog's sample config with two kinds of change; a saved node keeps what it has:
 *
 * - Fields the person has to fill start empty instead of holding example values that look like real config (an example
 *   URL, three sample Set rows, a `status = active` condition, a `documents` loop key). The editor shows the examples
 *   as grey placeholders, and the catalog keeps them as examples.
 * - A Schedule Trigger starts switched off, so a new workflow never fires on its own before the person turns it on.
 */

/** Values that replace the sample's for a new node (each is what the node needs before it does anything). */
const BLANK_FIELDS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  http_request: { urlTemplate: "" },
  set_node: { assignments: [{ key: "", valueTemplate: "", type: "auto" }] },
  filter_node: { conditions: [{ field: "", operator: "eq", value: "" }] },
  loop_node: { inputKey: "" },
  // The tool's name, description and input are the person's to describe; the catalog's knowledge-base example stays a
  // placeholder. An empty input schema takes no arguments until fields are added.
  mcp_server_trigger: { toolName: "", toolDescription: "", inputSchema: { type: "object", properties: {} } },
  human_approval: { approvalMessage: "" },
  user_prompt: { text: "" }
};

/** Sample keys a new node leaves out: they only matter once another setting asks for them. */
const DROPPED_FIELDS: Readonly<Record<string, readonly string[]>> = {
  // The combine key matters only in "Combine by Key" mode, where its field shows `id` as a placeholder.
  merge_node: ["combineKey"]
};

/** A new node's base config: the sample with example values blanked and a schedule switched off. Never changes the sample. */
export function newNodeBaseConfig(nodeType: string, sampleConfig: Record<string, unknown> | undefined): Record<string, unknown> {
  const config: Record<string, unknown> = { ...structuredClone(sampleConfig ?? {}), ...structuredClone(BLANK_FIELDS[nodeType] ?? {}) };
  for (const key of DROPPED_FIELDS[nodeType] ?? []) delete config[key];
  if (nodeType === "schedule_trigger") config.active = false;
  return config;
}

/** Whether `zone` is an IANA time zone this runtime knows. */
export function isKnownTimeZone(zone: string): boolean {
  if (!zone.trim()) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
