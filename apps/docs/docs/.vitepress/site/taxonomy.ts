// The fixed groupings of the knowledge hub: glossary topics and what a recipe needs to run.
// Shared by the config (sidebars) and the theme (index pages), so it imports nothing from Node.

export interface Group {
  id: string;
  label: string;
}

/** A glossary term's `topic` frontmatter is one of these ids. */
export const GLOSSARY_TOPICS: Group[] = [
  { id: "mcp", label: "MCP" },
  { id: "agents", label: "Agents and retrieval" },
  { id: "security", label: "Security" },
  { id: "testing", label: "Testing" },
  { id: "operations", label: "Operations and governance" }
];

/** A recipe's `keys` (from recipes.config.json): what it needs before it runs. */
export const RECIPE_KEYS: Group[] = [
  { id: "none", label: "Runs with no API key" },
  { id: "model", label: "Needs a model key" },
  { id: "services", label: "Needs other services" }
];
