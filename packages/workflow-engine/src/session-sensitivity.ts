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
 * `sensitive_memory`), its output labels say `sensitive` when the row carried the mark, and what it writes to session
 * state is marked in turn. With capture off nothing is exported anyway: rows written by sensitive work are still
 * marked, but reads add no label and memory reads make no extra query, so labels flow exactly as before v73. A tool
 * cache record or session artifact carries its mark in the row itself, so reading one still marks what the run writes.
 *
 * Sensitive work, when a row is written: a node of the run (or of a sub-workflow it calls) declares a sensitive source
 * (checked once per run, on the first write, failing closed), a Reveal node revealed something, the writing node's
 * input labels or the labels written with the row say sensitive, or the run read a marked row.
 */
export class SessionSensitivity {
  private readMarked: boolean;
  private readMarkedRow: boolean;
  private declared: Promise<boolean> | undefined;

  constructor(
    private readonly options: {
      /**
       * Content capture is on for the run. Only then does a read of a marked row add the `sensitive` label (and the
       * run's output labels), and only then is a memory read's mark looked up (one more query per read).
       */
      contentCapture: boolean;
      /** The run's declared sensitive sources (the content capture check); called at most once. */
      declared: () => Promise<boolean>;
      /** Sensitive work right now, apart from declared sources (Reveal, the running node's input labels). */
      workSensitive: () => boolean;
      /** A resumed run that had read a marked row before it paused. */
      readBefore?: boolean;
      /** A resumed run that had read a row carrying the mark while content capture was on (labels it `sensitive`). */
      readMarkedBefore?: boolean;
      /**
       * Called on each read of a row carrying the v73 mark (the engine adds `sensitive` to the reading node's labels). A
       * row that is sensitive only by its stored labels does not call it: those labels reach the run through label
       * tracking already, as they did before v73.
       */
      onSensitiveRead?: () => void;
    }
  ) {
    this.readMarked = options.readBefore === true || options.readMarkedBefore === true;
    this.readMarkedRow = options.readMarkedBefore === true && options.contentCapture;
  }

  /** Whether a memory read looks up the row's mark (content capture on). */
  get checksMemoryReads(): boolean {
    return this.options.contentCapture;
  }

  /** True once the run read a row written by sensitive work. */
  get readSensitive(): boolean {
    return this.readMarked;
  }

  /** True once the run read a row carrying the v73 mark (the run's output labels then say `sensitive`). */
  get readMarkedSensitive(): boolean {
    return this.readMarkedRow;
  }

  /** The content exclusion answer for what the run read: `sensitive_memory` once it read a marked row. */
  exclusion(): string | false {
    return this.readMarked ? CONTENT_DROPPED_SENSITIVE_MEMORY : false;
  }

  /** Notes a read: `sensitive` by mark or stored labels; `marked` when the row carried the v73 mark itself. */
  noteRead(sensitive: boolean, marked = sensitive): void {
    if (!sensitive) return;
    this.readMarked = true;
    if (!marked || !this.options.contentCapture) return;
    this.readMarkedRow = true;
    try {
      this.options.onSensitiveRead?.();
    } catch {
      // Labels are best effort here: the run is already sensitive for content capture and marks what it writes.
    }
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

type SessionRow = { sensitive?: boolean; labels?: DataLabels | null } | null | undefined;

/** Notes rows as read: sensitive when marked or stored with labels that say sensitive; marked when any carries the mark. */
function noteRows(sensitivity: SessionSensitivity, rows: readonly SessionRow[]): void {
  const marked = rows.some((row) => row?.sensitive === true);
  sensitivity.noteRead(marked || rows.some((row) => labelsMarkSensitive(row?.labels)), marked);
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
              // A store without the v73 mark is left to label tracking: on tracked runs the engine reads its stored labels
              // (once, as before v73) and they keep the content out; an untracked run reads no labels at all.
              // With capture off the mark is not looked up: nothing is exported, and labels flow as before v73.
              if (messages.length > 0 && memoryStore.loadSensitive && sensitivity.checksMemoryReads) {
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
              if (options?.sensitive !== true && !(await sensitivity.writeSensitive(options?.labels))) return await memoryStore.saveMessages(...args);
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
              noteRows(sensitivity, rows);
              return rows;
            },
            getToolCall: async (input: Parameters<typeof toolDataStore.getToolCall>[0]) => {
              const row = await toolDataStore.getToolCall(input);
              noteRows(sensitivity, [row]);
              return row;
            },
            saveToolCall: async (input: Parameters<typeof toolDataStore.saveToolCall>[0]) =>
              input.sensitive === true || (await sensitivity.writeSensitive(input.labels))
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
              noteRows(sensitivity, [row]);
              return row;
            },
            saveArtifact: async (input: Parameters<typeof sessionArtifactStore.saveArtifact>[0]) =>
              input.sensitive === true || (await sensitivity.writeSensitive(input.labels))
                ? await sessionArtifactStore.saveArtifact({ ...input, sensitive: true })
                : await sessionArtifactStore.saveArtifact(input)
          }
        }
      : {})
  };
}
