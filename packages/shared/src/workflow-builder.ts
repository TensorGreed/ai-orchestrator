/**
 * Describe-it builder: a person describes a workflow in words and a model drafts it. The model's answer is only data:
 * it is validated against the workflow schema and the graph rules, never run while building, and nothing is saved
 * until the person inserts the preview as a new draft. These are the request and answer shapes shared by the API and
 * the studio, and the pure helpers both use.
 */
import { z } from "zod";
import type { Workflow } from "./types";

/** The longest description a person can send. */
export const WORKFLOW_BUILDER_PROMPT_MAX_CHARS = 2000;
/** How many workflows the model may submit before the build gives up (the first try and two repairs). */
export const WORKFLOW_BUILDER_MAX_ATTEMPTS = 3;
/** The most nodes a built workflow may have. */
export const WORKFLOW_BUILDER_MAX_NODES = 40;
/** The most edges a built workflow may have. */
export const WORKFLOW_BUILDER_MAX_EDGES = 80;

/** The model the builder talks to: the same shape as an LLM Call node's `config.provider`. */
export const workflowBuilderModelSchema = z
  .object({
    providerId: z.string().trim().min(1).max(64),
    model: z.string().trim().min(1).max(200),
    baseUrl: z.string().trim().url().max(2048).optional(),
    secretRef: z.object({ secretId: z.string().trim().min(1).max(200) }).strict().optional()
  })
  .strict();

export type WorkflowBuilderModel = z.infer<typeof workflowBuilderModelSchema>;

export const workflowBuilderRequestSchema = z
  .object({
    prompt: z.string().trim().min(1, "Describe what the workflow should do").max(WORKFLOW_BUILDER_PROMPT_MAX_CHARS),
    /** The project the draft is for (default: the default project). */
    projectId: z.string().trim().min(1).max(120).optional(),
    /** The model to use. Absent: the default model (a server key, else a saved secret, else Echo). */
    model: workflowBuilderModelSchema.optional()
  })
  .strict();

export type WorkflowBuilderRequest = z.infer<typeof workflowBuilderRequestSchema>;

export interface WorkflowBuilderIssue {
  message: string;
  nodeId?: string;
}

/** A template offered instead of a build (no real model). */
export interface WorkflowBuilderTemplateSuggestion {
  id: string;
  name: string;
  description: string;
  category?: string;
}

/** What the person sees before inserting a built workflow. */
export interface WorkflowBuilderPreview {
  /** Every node the draft creates, in workflow order. */
  nodes: Array<{ id: string; label: string; type: string; typeLabel: string }>;
  /** Credentials the person picks after inserting (the builder never fills them in). */
  credentials: Array<{ nodeId: string; nodeLabel: string; label: string; hint: string; required: boolean }>;
  /** Settings that are still unfinished: the draft saves, and the editor lists them until they are filled in. */
  unfinished: WorkflowBuilderIssue[];
  /** Addresses the workflow would call when it runs (HTTP URLs, endpoints, base URLs). */
  addresses: Array<{ nodeId: string; nodeLabel: string; url: string }>;
  /** What the builder changed in the model's answer (credentials removed, settings it may not set). */
  notes: string[];
}

export interface WorkflowBuilderModelInfo {
  providerId: string;
  model: string;
}

export type WorkflowBuilderResult =
  | {
      status: "ready";
      /** A new workflow (fresh id) for the project; not saved. */
      workflow: Workflow;
      preview: WorkflowBuilderPreview;
      /** How many workflows the model submitted (1 = right the first time). */
      attempts: number;
      model: WorkflowBuilderModelInfo;
    }
  | { status: "needs_model"; message: string; templates: WorkflowBuilderTemplateSuggestion[] }
  | { status: "question"; question: string; model: WorkflowBuilderModelInfo }
  | { status: "failed"; message: string; issues: WorkflowBuilderIssue[]; attempts: number; model: WorkflowBuilderModelInfo };

const STOP_WORDS = new Set([
  "a", "an", "and", "the", "to", "of", "in", "on", "for", "with", "from", "into", "by", "it", "its", "is", "are", "be",
  "then", "that", "this", "when", "each", "every", "my", "me", "i", "we", "our", "us", "as", "at", "or", "if", "so",
  "workflow", "flow", "please", "should", "want", "make", "build", "create", "new", "use", "using", "via", "get", "send"
]);

/** The words of a text worth matching on (lower case, no stop words, a trailing plural `s` removed). */
export function builderKeywords(text: string): string[] {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word))
    .map((word) => (word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word));
  return [...new Set(words)];
}

/**
 * The templates closest to a description, best first: a word of the description in the template's name counts most,
 * then its tags, category and description. Templates that need a model (`needsModel`) come after the ones that run
 * without one, since they are offered when no real model is set. Featured templates win ties, so a vague description
 * still gets the starting points the gallery leads with.
 */
export function rankTemplatesForPrompt<
  T extends { id: string; name: string; description?: string; category?: string; tags?: readonly string[]; featured?: boolean; needsModel?: boolean }
>(prompt: string, templates: readonly T[], limit = 3): T[] {
  const wanted = builderKeywords(prompt);
  const scored = templates.map((template, index) => {
    const name = new Set(builderKeywords(template.name));
    const tags = new Set(builderKeywords((template.tags ?? []).join(" ")));
    const category = new Set(builderKeywords(template.category ?? ""));
    const description = new Set(builderKeywords(template.description ?? ""));
    let score = 0;
    for (const word of wanted) {
      if (name.has(word)) score += 4;
      if (tags.has(word)) score += 3;
      if (category.has(word)) score += 2;
      if (description.has(word)) score += 1;
    }
    return { template, index, score };
  });
  scored.sort(
    (a, b) =>
      Number(Boolean(a.template.needsModel)) - Number(Boolean(b.template.needsModel)) ||
      b.score - a.score ||
      Number(Boolean(b.template.featured)) - Number(Boolean(a.template.featured)) ||
      a.index - b.index
  );
  return scored.slice(0, Math.max(0, limit)).map((entry) => entry.template);
}
