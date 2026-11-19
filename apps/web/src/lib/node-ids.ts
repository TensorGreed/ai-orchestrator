/**
 * Readable ids for new nodes: `fetch_items` for a node labelled "Fetch items", so a template that reads an earlier
 * step (`{{results.fetch_items.body}}`) says what it reads. Ids of saved nodes never change: run history, pinned
 * data, approvals and templates refer to them.
 *
 * Rules:
 * - lower case letters, digits and `_`, starting with a letter, at most 40 characters;
 * - a one-word label is numbered (`set_1`), so the id never reads like an output field (`{{set}}`) a node passes on;
 * - names a run's templates already read (`results`, `vars`, `user_prompt`, ...) are numbered too;
 * - a taken id (a node of the workflow, pinned data, a node of the last run) gets the next free number.
 */
const MAX_ID_LENGTH = 40;

/** Names the template data of every node holds (engine `buildTemplateData`) and the run's own fields. */
const RESERVED_IDS = new Set([
  "results",
  "vars",
  "workflow",
  "execution",
  "parent_outputs",
  "user_prompt",
  "system_prompt",
  "session_id",
  "execution_id",
  "execution_custom_data",
  "trigger_type",
  "input_trigger_type",
  "scheduled_at",
  "submitted_at",
  "form_submission",
  "rss_items",
  "file_events",
  "error_stack",
  "watch_path",
  "feed_url",
  "sse_url",
  "sse_event",
  "mq_message",
  "mq_metadata",
  "source_workflow_id",
  "source_workflow_name",
  "source_execution_id",
  "webhook",
  "item",
  "items"
]);

function slugOf(label: string): string {
  const ascii = label.normalize("NFKD").replace(/[̀-ͯ]/g, "");
  let slug = ascii
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (slug && !/^[a-z]/.test(slug)) slug = `n_${slug}`;
  // Room for a `_NN` suffix; never end on `_`.
  return slug.slice(0, MAX_ID_LENGTH - 4).replace(/_+$/, "");
}

/** A readable id for a new node with this label, not in `taken`; the id is added to `taken`. */
export function readableNodeId(label: string, nodeType: string, taken: Set<string>): string {
  const base = slugOf(label) || slugOf(nodeType) || "node";
  const numbered = !base.includes("_") || RESERVED_IDS.has(base);
  let id = numbered ? `${base}_1` : base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}_${n}`;
  taken.add(id);
  return id;
}
