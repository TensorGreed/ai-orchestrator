/**
 * Relevance ranking for the node palette's search. A query is scored against each node's label, then its other
 * names (aliases and its type id), then its description; lower scores rank first and items that match nothing are
 * left out. Equal scores keep the palette's own order.
 */

export interface PaletteSearchItem {
  type: string;
  label: string;
  description: string;
}

/** Other words people use for a node, by node type. Only nouns and verbs a user would type, never product names. */
export const PALETTE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  http_request: ["api", "rest", "fetch", "request", "call url", "get", "post", "curl"],
  if_node: ["condition", "branch", "if else"],
  switch_node: ["case", "route", "router"],
  loop_node: ["foreach", "for each", "iterate", "each"],
  set_node: ["map", "assign", "fields"],
  edit_fields_node: ["assign", "map"],
  code_node: ["javascript", "js", "script", "function"],
  python_code: ["python", "py", "script"],
  schedule_trigger: ["cron", "timer", "interval"],
  webhook_input: ["incoming http", "http trigger", "endpoint"],
  manual_trigger: ["start", "button"],
  output: ["result", "return", "end", "response"],
  llm_call: ["ai", "model", "chat", "prompt", "completion"],
  agent_orchestrator: ["agent", "assistant", "tool calling"],
  wait_node: ["sleep", "pause", "delay"],
  merge_node: ["join", "combine"],
  filter_node: ["where", "keep"],
  human_approval: ["approve", "review", "sign off"],
  approval_gate: ["approve", "review", "sign off"],
  smtp_send_email: ["email", "mail"],
  noop_node: ["noop", "nothing", "pass through"],
  sticky_note: ["note", "comment"],
  rag_retrieve: ["knowledge", "retrieval", "search documents"],
  try_catch: ["error handling", "catch"],
  stop_and_error: ["fail", "throw"]
};

const SCORE = {
  exactLabel: 0,
  exactType: 1,
  labelPrefix: 1,
  exactAlias: 2,
  labelWordPrefix: 3,
  aliasPrefix: 4,
  labelSubstring: 5,
  typeSubstring: 6,
  descriptionWordPrefix: 7,
  descriptionSubstring: 8
} as const;

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

function words(text: string): string[] {
  return text.split(/[^a-z0-9]+/).filter(Boolean);
}

/** True when `query` (one or more words) starts at a word boundary of `text`. */
function startsAtWord(text: string, query: string): boolean {
  if (text.startsWith(query)) return true;
  const queryWords = words(query);
  const textWords = words(text);
  if (queryWords.length === 0) return false;
  for (let start = 0; start < textWords.length; start += 1) {
    const ok = queryWords.every((word, offset) => {
      const candidate = textWords[start + offset];
      if (candidate === undefined) return false;
      return offset === queryWords.length - 1 ? candidate.startsWith(word) : candidate === word;
    });
    if (ok) return true;
  }
  return false;
}

/** The item's score for `query` (lower is better), or null when it does not match. An empty query matches everything. */
export function scorePaletteItem(item: PaletteSearchItem, rawQuery: string): number | null {
  const query = normalize(rawQuery);
  if (!query) return SCORE.descriptionSubstring;
  const label = normalize(item.label);
  const type = item.type.toLowerCase();
  const aliases = PALETTE_ALIASES[item.type] ?? [];
  const description = normalize(item.description);

  if (label === query || words(label).join(" ") === words(query).join(" ")) return SCORE.exactLabel;
  if (type === query) return SCORE.exactType;
  if (label.startsWith(query)) return SCORE.labelPrefix;
  if (aliases.includes(query)) return SCORE.exactAlias;
  if (startsAtWord(label, query)) return SCORE.labelWordPrefix;
  if (aliases.some((alias) => alias.startsWith(query))) return SCORE.aliasPrefix;
  if (label.includes(query)) return SCORE.labelSubstring;
  if (type.includes(query)) return SCORE.typeSubstring;
  if (startsAtWord(description, query)) return SCORE.descriptionWordPrefix;
  if (description.includes(query)) return SCORE.descriptionSubstring;
  return null;
}

/** The items that match `query`, best first; equal scores keep their input order. */
export function rankPaletteItems<T extends PaletteSearchItem>(items: readonly T[], query: string): T[] {
  if (!normalize(query)) return [...items];
  return items
    .map((item, index) => ({ item, index, score: scorePaletteItem(item, query) }))
    .filter((entry): entry is { item: T; index: number; score: number } => entry.score !== null)
    .sort((left, right) => left.score - right.score || left.index - right.index)
    .map((entry) => entry.item);
}
