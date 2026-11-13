import { DEFAULT_PROJECT_ID, type Workflow } from "@ai-orchestrator/shared";
import type { WorkflowExecutionDependencies } from "./executor";
import type { GuardRuntimeDependencies } from "./guard-runtime";

/**
 * Phase 12 coverage — what a Reveal node revealed stays in the run's memory only.
 *
 * Downstream nodes of the same run get the revealed values. Everything the run hands outside keeps the tokens:
 * the run's result (node results, output, errors, activity), the paused state, the live events, the error
 * workflow's input and the agent session stores (memory, tool cache, artifacts). Each revealed value is put back as
 * the token it came from wherever it appears verbatim. A value a node changed (cut, reformatted, re-encoded) is not
 * found; destination rules govern where such values may go.
 */

/** Values shorter than this are not put back (a two-character value would rewrite unrelated text). */
export const REVEAL_REDACTION_MIN_LENGTH = 3;
const MAX_DEPTH = 64;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export class RevealRedactor {
  /** Revealed value → its token. */
  private readonly tokens = new Map<string, string>();
  private pattern: RegExp | undefined;

  /** Registers a revealed value and the token it came from. */
  add(value: string, token: string): void {
    if (value.length < REVEAL_REDACTION_MIN_LENGTH || value === token) return;
    // A value as it appears inside serialised JSON (quotes and backslashes escaped) is put back too.
    const variants = new Set([value, JSON.stringify(value).slice(1, -1)]);
    const tokenVariant = JSON.stringify(token).slice(1, -1);
    for (const variant of variants) {
      if (!this.tokens.has(variant)) this.tokens.set(variant, variant === value ? token : tokenVariant);
    }
    this.pattern = undefined;
  }

  /** True once something was revealed in this run. */
  get active(): boolean {
    return this.tokens.size > 0;
  }

  redactText(text: string): string {
    if (this.tokens.size === 0 || text.length < REVEAL_REDACTION_MIN_LENGTH) return text;
    if (!this.pattern) {
      // Longer values first, so a value that contains another is replaced whole.
      const values = [...this.tokens.keys()].sort((a, b) => b.length - a.length);
      this.pattern = new RegExp(values.map(escapeRegExp).join("|"), "g");
    }
    return text.replace(this.pattern, (match) => this.tokens.get(match) ?? match);
  }

  /** A copy of `value` with every revealed value put back as its token; `value` itself when nothing was revealed. */
  redact<T>(value: T): T {
    if (this.tokens.size === 0) return value;
    return this.walk(value, 0, new WeakMap()) as T;
  }

  private walk(value: unknown, depth: number, seen: WeakMap<object, unknown>): unknown {
    if (typeof value === "string") return this.redactText(value);
    if (!value || typeof value !== "object" || depth > MAX_DEPTH) return value;
    const known = seen.get(value);
    if (known !== undefined) return known;
    if (Array.isArray(value)) {
      const next: unknown[] = [];
      seen.set(value, next);
      for (const item of value) next.push(this.walk(item, depth + 1, seen));
      return next;
    }
    if (value instanceof Error) {
      const copy = new Error(this.redactText(value.message));
      copy.name = value.name;
      seen.set(value, copy);
      return copy;
    }
    if (!isPlainObject(value)) return value;
    const next: Record<string, unknown> = Object.getPrototypeOf(value) === null ? Object.create(null) : {};
    seen.set(value, next);
    for (const [key, item] of Object.entries(value)) next[key] = this.walk(item, depth + 1, seen);
    return next;
  }
}

type SessionStores = Pick<WorkflowExecutionDependencies, "memoryStore" | "toolDataStore" | "sessionArtifactStore">;

/** The session stores with writes put back to tokens (reads are unchanged). */
export function redactingSessionStores(dependencies: SessionStores, redactor: RevealRedactor): SessionStores {
  const { memoryStore, toolDataStore, sessionArtifactStore } = dependencies;
  return {
    ...(memoryStore
      ? {
          memoryStore: {
            ...memoryStore,
            loadMessages: memoryStore.loadMessages.bind(memoryStore),
            ...(memoryStore.loadLabels ? { loadLabels: memoryStore.loadLabels.bind(memoryStore) } : {}),
            ...(memoryStore.loadSensitive ? { loadSensitive: memoryStore.loadSensitive.bind(memoryStore) } : {}),
            ...(memoryStore.loadMessagesMarked ? { loadMessagesMarked: memoryStore.loadMessagesMarked.bind(memoryStore) } : {}),
            // The arguments as given (an absent options argument stays absent).
            saveMessages: async (...args: Parameters<typeof memoryStore.saveMessages>) =>
              await memoryStore.saveMessages(...([args[0], args[1], redactor.redact(args[2]), ...args.slice(3)] as Parameters<typeof memoryStore.saveMessages>))
          }
        }
      : {}),
    ...(toolDataStore
      ? {
          toolDataStore: {
            ...toolDataStore,
            listToolCalls: toolDataStore.listToolCalls.bind(toolDataStore),
            getToolCall: toolDataStore.getToolCall.bind(toolDataStore),
            saveToolCall: async (input) => await toolDataStore.saveToolCall(redactor.redact(input))
          }
        }
      : {}),
    ...(sessionArtifactStore
      ? {
          sessionArtifactStore: {
            ...sessionArtifactStore,
            loadArtifact: sessionArtifactStore.loadArtifact.bind(sessionArtifactStore),
            saveArtifact: async (input) => await sessionArtifactStore.saveArtifact(redactor.redact(input))
          }
        }
      : {})
  };
}

function redactingCallback<A extends unknown[], R>(callback: ((...args: A) => R) | undefined, redactor: RevealRedactor): ((...args: A) => R) | undefined {
  if (!callback) return undefined;
  return (...args: A) => callback(...(redactor.redact(args) as A));
}

/**
 * The top-level run's dependencies with everything that leaves the run put back to tokens: live events, the
 * paused state, the error workflow's input, log metadata and the session stores. Streamed model deltas stop once
 * something was revealed (a value can be split across deltas); the node's complete event carries the text.
 */
export function redactingDependencies(dependencies: WorkflowExecutionDependencies, redactor: RevealRedactor): WorkflowExecutionDependencies {
  const onLLMDelta = dependencies.onLLMDelta;
  return {
    ...dependencies,
    ...redactingSessionStores(dependencies, redactor),
    onNodeStart: redactingCallback(dependencies.onNodeStart, redactor),
    onNodeComplete: redactingCallback(dependencies.onNodeComplete, redactor),
    onLLMDelta: onLLMDelta ? async (event) => (redactor.active ? undefined : await onLLMDelta(event)) : undefined,
    onMcpProgress: redactingCallback(dependencies.onMcpProgress, redactor),
    onNodeActivity: redactingCallback(dependencies.onNodeActivity, redactor),
    onMcpElicitation: redactingCallback(dependencies.onMcpElicitation, redactor),
    persistPausedExecution: redactingCallback(dependencies.persistPausedExecution, redactor),
    triggerErrorWorkflow: redactingCallback(dependencies.triggerErrorWorkflow, redactor),
    logger: redactingCallback(dependencies.logger, redactor)
  };
}

/**
 * Phase 12 coverage — content rules for a sub-workflow. The API scopes them to the child's project
 * (`forWorkflow`). Without that hook, a child in another project than the run's never reveals.
 */
export function childGuardFor(guard: GuardRuntimeDependencies, child: Pick<Workflow, "id" | "projectId">): GuardRuntimeDependencies {
  if (guard.forWorkflow) return guard.forWorkflow({ id: child.id, projectId: child.projectId ?? null });
  if (guard.projectId === undefined || (child.projectId ?? DEFAULT_PROJECT_ID) === (guard.projectId ?? DEFAULT_PROJECT_ID)) return guard;
  const { onReveal: _onReveal, ...rest } = guard;
  return { ...rest, revealDisabled: true };
}
