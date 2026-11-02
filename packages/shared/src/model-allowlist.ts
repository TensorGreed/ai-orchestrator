import { z } from "zod";

/**
 * 12.6 (D7) — model allowlists.
 *
 * An optional list of `{providerId, modelGlob}` entries at two scopes: the
 * whole deployment, and one project. A model call is allowed when it matches
 * the deployment list (if that list has entries) AND the project's list (if
 * that list has entries). An empty list puts no restriction on its own, so
 * with no entries anywhere every model is allowed, exactly as before. A
 * project list can only narrow the deployment list, never widen it: a call
 * the deployment list refuses is refused whatever the project allows.
 *
 * Matching:
 *   - `providerId` is the provider registry id the call goes to (`openai`,
 *     `anthropic`, `azure_openai`, `openai_compatible`, `ollama`, `gemini`,
 *     `echo`, or a community provider's id), compared exactly; `*` matches
 *     any provider.
 *   - `modelGlob` is matched against the model name the provider is sent,
 *     ignoring case: `*` is any run of characters (also none), `?` is one
 *     character, everything else is literal. For `azure_openai` the model
 *     name is the deployment name (what the adapter sends); for
 *     `openai_compatible` it is the `model` field, whatever endpoint the node
 *     points at.
 */

export const MODEL_ALLOWLIST_SCOPES = ["deployment", "project"] as const;
export type ModelAllowlistScope = (typeof MODEL_ALLOWLIST_SCOPES)[number];

/** The `providerId` that matches every provider. */
export const MODEL_ALLOWLIST_ANY_PROVIDER = "*";
/** At most this many entries per scope (deployment, or one project): the list is read on every model call. */
export const MODEL_ALLOWLIST_MAX_ENTRIES_PER_SCOPE = 200;
/** The error code a refused model call carries (`ModelNotAllowedError.code`). */
export const MODEL_NOT_ALLOWED_CODE = "MODEL_NOT_ALLOWED";
/** The validation issue code of a builder warning about a model the allowlist refuses. */
export const MODEL_NOT_ALLOWED_ISSUE_CODE = "model_not_allowed";

export interface ModelAllowlistEntry {
  id: string;
  scope: ModelAllowlistScope;
  /** The project of a `project` entry; null for a `deployment` entry. */
  projectId: string | null;
  providerId: string;
  modelGlob: string;
  note: string | null;
  createdAt: string;
  createdBy: string | null;
}

const providerIdSchema = z
  .string()
  .trim()
  .min(1, "Choose a provider")
  .max(100)
  .regex(/^(\*|[A-Za-z0-9][A-Za-z0-9_.:-]*)$/, "A provider id, or * for any provider");

const modelGlobSchema = z
  .string()
  .trim()
  .min(1, "Enter a model name or pattern (for example gpt-4o* or *)")
  .max(200)
  .refine((value) => !/[\u0000-\u001f]/.test(value), "No control characters");

export const modelAllowlistEntryCreateSchema = z
  .object({
    scope: z.enum(MODEL_ALLOWLIST_SCOPES),
    projectId: z.string().trim().min(1).max(200).optional().nullable(),
    providerId: providerIdSchema,
    modelGlob: modelGlobSchema,
    note: z.string().trim().max(200).optional().nullable()
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.scope === "project" && !value.projectId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["projectId"], message: "A project entry names its project" });
    }
    if (value.scope === "deployment" && value.projectId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["projectId"], message: "A deployment entry has no project" });
    }
  });

export type ModelAllowlistEntryCreate = z.infer<typeof modelAllowlistEntryCreateSchema>;

/**
 * Does `model` match `glob` (`*` any run, `?` one character, case ignored)?
 * A greedy two-pointer match with backtracking to the last `*` only, so it
 * takes at most pattern × text steps whatever the input (no regex).
 */
export function modelGlobMatches(glob: string, model: string): boolean {
  const pattern = [...glob.trim().toLowerCase()];
  const text = [...model.trim().toLowerCase()];
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (p < pattern.length && (pattern[p] === "?" || (pattern[p] !== "*" && pattern[p] === text[t]))) {
      p += 1;
      t += 1;
    } else if (p < pattern.length && pattern[p] === "*") {
      star = p;
      mark = t;
      p += 1;
    } else if (star !== -1) {
      p = star + 1;
      mark += 1;
      t = mark;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === "*") p += 1;
  return p === pattern.length;
}

export function modelAllowlistEntryMatches(entry: Pick<ModelAllowlistEntry, "providerId" | "modelGlob">, providerId: string, model: string): boolean {
  return (entry.providerId === MODEL_ALLOWLIST_ANY_PROVIDER || entry.providerId === providerId) && modelGlobMatches(entry.modelGlob, model);
}

/**
 * The model name a provider config sends: the deployment name for Azure
 * OpenAI (`extra.deployment`, else `model`, as the adapter reads it), the
 * `model` field otherwise.
 */
export function effectiveModelName(provider: { providerId: string; model?: unknown; extra?: Record<string, unknown> | undefined }): string {
  if (provider.providerId === "azure_openai") {
    const deployment = provider.extra?.deployment;
    if (typeof deployment === "string" && deployment.trim()) return deployment.trim();
  }
  return typeof provider.model === "string" ? provider.model.trim() : "";
}

export type ModelAllowlistDecision =
  | { allowed: true; reason: "no_lists" | "allowed"; deploymentEntries: number; projectEntries: number }
  | { allowed: false; reason: "deployment" | "project"; deploymentEntries: number; projectEntries: number; message: string };

export interface ModelAllowlistCall {
  providerId: string;
  model: string;
  /** The project whose list applies; null or absent: the deployment list alone. */
  projectId?: string | null;
}

/** Plain-English sentence for a refused call. */
export function modelNotAllowedMessage(call: ModelAllowlistCall, refusedBy: "deployment" | "project"): string {
  const model = call.model || "(no model)";
  return refusedBy === "deployment"
    ? `Model "${model}" on provider "${call.providerId}" is not on this deployment's model allowlist.`
    : `Model "${model}" on provider "${call.providerId}" is not on the model allowlist of project "${call.projectId}".`;
}

/**
 * Is this model call allowed by `entries` (every entry of the deployment;
 * project entries of other projects are ignored)? See the module comment.
 */
export function evaluateModelAllowlist(entries: ReadonlyArray<ModelAllowlistEntry>, call: ModelAllowlistCall): ModelAllowlistDecision {
  const deployment = entries.filter((entry) => entry.scope === "deployment");
  const project = call.projectId ? entries.filter((entry) => entry.scope === "project" && entry.projectId === call.projectId) : [];
  const counts = { deploymentEntries: deployment.length, projectEntries: project.length };
  if (deployment.length === 0 && project.length === 0) return { allowed: true, reason: "no_lists", ...counts };
  if (deployment.length > 0 && !deployment.some((entry) => modelAllowlistEntryMatches(entry, call.providerId, call.model))) {
    return { allowed: false, reason: "deployment", message: modelNotAllowedMessage(call, "deployment"), ...counts };
  }
  if (project.length > 0 && !project.some((entry) => modelAllowlistEntryMatches(entry, call.providerId, call.model))) {
    return { allowed: false, reason: "project", message: modelNotAllowedMessage(call, "project"), ...counts };
  }
  return { allowed: true, reason: "allowed", ...counts };
}
