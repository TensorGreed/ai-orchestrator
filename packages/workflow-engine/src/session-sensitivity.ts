import { CONTENT_DROPPED_SENSITIVE_MEMORY, labelsMarkSensitive, type DataLabels } from "@ai-orchestrator/shared";
import type { WorkflowExecutionDependencies } from "./executor";

/**
 * v73 — session state written by sensitive work stays out of exported content in later runs.
 *
 * Session memory, the session tool cache and session artifacts outlive the run that wrote them and reach later runs'
 * model input (agent memory, `session_cache_get`, a Simple Memory or Session Artifact Load node feeding a prompt). A row
 * written by work that content capture treats as sensitive is marked (`sensitive` = 1), whether or not capture is on
 * at the time, so turning capture on later cannot export it. A run that reads a marked row (or a row whose stored
 * labels say sensitive) is sensitive from then on: its spans export no content (`l2m.content.dropped` =
 * `sensitive_memory`), and what it writes to session state is marked in turn. With capture off nothing is exported
 * anyway; only the marks are kept, and memory works as before.
 *
 * Sensitive work, when a row is written: a node of the run (or of a sub-workflow it calls) declares a sensitive source
 * (checked once per run, on the first write, failing closed), a Reveal node revealed something, the writing node's
 * input labels or the labels written with the row say sensitive, or the run read a marked row.
 */
export class SessionSensitivity {
  private readMarked: boolean;
  private declared: Promise<boolean> | undefined;

  constructor(
    private readonly options: {
      /** The run's declared sensitive sources (the content capture check); called at most once. */
      declared: () => Promise<boolean>;
      /** Sensitive work right now, apart from declared sources (Reveal, the running node's input labels). */
      workSensitive: () => boolean;
      /** A resumed run that had read a marked row before it paused. */
      readBefore?: boolean;
    }
  ) {
    this.readMarked = options.readBefore === true;
  }

  /** True once the run read a row written by sensitive work. */
  get readSensitive(): boolean {
    return this.readMarked;
  }

  /** The content exclusion answer for what the run read: `sensitive_memory` once it read a marked row. */
  exclusion(): string | false {
    return this.readMarked ? CONTENT_DROPPED_SENSITIVE_MEMORY : false;
  }

  noteRead(sensitive: boolean): void {
    if (sensitive) this.readMarked = true;
  }

  /** Whether a row written now (with `labels`, if the run tracks them) is marked. Fails closed. */
  async writeSensitive(labels?: DataLabels | null): Promise<boolean> {
    if (this.readMarked || labelsMarkSensitive(labels)) return true;
    try {
      if (this.options.workSensitive()) return true;
    } catch {
      return true;
    }
    // promise-ok: memoised so concurrent writes share the one check; every caller awaits it below
    this.declared ??= this.options.declared().then(
      (declared) => declared,
      () => true
    );
    return await this.declared;
  }
}

/** A row as read: marked, or stored with labels that say sensitive. */
function rowSensitive(row: { sensitive?: boolean; labels?: DataLabels | null } | null | undefined): boolean {
  return Boolean(row && (row.sensitive === true || labelsMarkSensitive(row.labels)));
}

type SessionStores = Pick<WorkflowExecutionDependencies, "memoryStore" | "toolDataStore" | "sessionArtifactStore">;

/**
 * The session stores with reads noted on `sensitivity` and writes marked by it. Arguments pass through as given: a write
 * that is not marked keeps its arguments exactly (an absent options argument stays absent).
 */
export function sensitivityTrackingSessionStores(dependencies: SessionStores, sensitivity: SessionSensitivity): SessionStores {
  const { memoryStore, toolDataStore, sessionArtifactStore } = dependencies;
  return {
    ...(memoryStore
      ? {
          memoryStore: {
            ...memoryStore,
            loadMessages: async (namespace: string, sessionId: string) => {
              const messages = await memoryStore.loadMessages(namespace, sessionId);
              if (messages.length > 0 && memoryStore.loadSensitive) {
                let sensitive: boolean;
                try {
                  sensitive = await memoryStore.loadSensitive(namespace, sessionId);
                } catch {
                  sensitive = true;
                }
                sensitivity.noteRead(sensitive);
              }
              return messages;
            },
            ...(memoryStore.loadLabels ? { loadLabels: memoryStore.loadLabels.bind(memoryStore) } : {}),
            ...(memoryStore.loadSensitive ? { loadSensitive: memoryStore.loadSensitive.bind(memoryStore) } : {}),
            saveMessages: async (...args: Parameters<typeof memoryStore.saveMessages>) => {
              const [namespace, sessionId, messages, options] = args;
              if (!(await sensitivity.writeSensitive(options?.labels))) return await memoryStore.saveMessages(...args);
              return await memoryStore.saveMessages(namespace, sessionId, messages, { ...options, sensitive: true });
            }
          }
        }
      : {}),
    ...(toolDataStore
      ? {
          toolDataStore: {
            ...toolDataStore,
            listToolCalls: async (input: Parameters<typeof toolDataStore.listToolCalls>[0]) => {
              const rows = await toolDataStore.listToolCalls(input);
              sensitivity.noteRead(rows.some(rowSensitive));
              return rows;
            },
            getToolCall: async (input: Parameters<typeof toolDataStore.getToolCall>[0]) => {
              const row = await toolDataStore.getToolCall(input);
              sensitivity.noteRead(rowSensitive(row));
              return row;
            },
            saveToolCall: async (input: Parameters<typeof toolDataStore.saveToolCall>[0]) =>
              (await sensitivity.writeSensitive(input.labels))
                ? await toolDataStore.saveToolCall({ ...input, sensitive: true })
                : await toolDataStore.saveToolCall(input)
          }
        }
      : {}),
    ...(sessionArtifactStore
      ? {
          sessionArtifactStore: {
            ...sessionArtifactStore,
            loadArtifact: async (input: Parameters<typeof sessionArtifactStore.loadArtifact>[0]) => {
              const row = await sessionArtifactStore.loadArtifact(input);
              sensitivity.noteRead(rowSensitive(row));
              return row;
            },
            saveArtifact: async (input: Parameters<typeof sessionArtifactStore.saveArtifact>[0]) =>
              (await sensitivity.writeSensitive(input.labels))
                ? await sessionArtifactStore.saveArtifact({ ...input, sensitive: true })
                : await sessionArtifactStore.saveArtifact(input)
          }
        }
      : {})
  };
}
