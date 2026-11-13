import { CONTENT_DROPPED_SENSITIVE_MEMORY, CONTENT_DROPPED_SENSITIVE_RUN_DATA, labelsMarkSensitive, type DataLabels } from "@ai-orchestrator/shared";
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
 * marked, but reads add no label and memory reads make no extra query, so labels flow exactly as before v73. Every row
 * carries its mark in the same read that loads it (memory too, on stores that implement `loadMessagesMarked`), so with
 * capture off reading a marked row still marks what the run writes.
 *
 * v74 — the same holds for content that reaches a run another way: a knowledge base chunk written by sensitive work
 * (`sensitive_knowledge`), and an error workflow's input, pinned data or node outputs copied from a run that was
 * sensitive work (`sensitive_run_data`).
 *
 * Sensitive work, when a row is written: a node of the run (or of a sub-workflow it calls) declares a sensitive source
 * (checked once per run, on the first write, failing closed), a Reveal node revealed something, the writing node's
 * input labels or the labels written with the row say sensitive, or the run read a marked row.
 */
export class SessionSensitivity {
  private readMarked: boolean;
  private readMarkedRow: boolean;
  private reason: string | undefined;
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
      /** v74 — the drop reason a resumed run had recorded for its read, when not `sensitive_memory`. */
      readReasonBefore?: string;
      /**
       * v74 — the run starts from content of a run that was sensitive work (an error workflow's input, node outputs
       * copied from such a run): sensitive from the start, as after a read of a marked row (`sensitive_run_data`).
       */
      carriedSensitive?: boolean;
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
    if (this.readMarked && typeof options.readReasonBefore === "string" && options.readReasonBefore) this.reason = options.readReasonBefore;
    if (options.carriedSensitive === true) this.noteCarried(CONTENT_DROPPED_SENSITIVE_RUN_DATA);
  }

  /** Whether a read of marked content adds the `sensitive` label (content capture on). */
  get labelsReads(): boolean {
    return this.options.contentCapture;
  }

  /** v74 — the drop reason of what the run read, when it is not `sensitive_memory` (kept across an approval pause). */
  get readReason(): string | undefined {
    return this.readMarked && this.reason !== CONTENT_DROPPED_SENSITIVE_MEMORY ? this.reason : undefined;
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

  /**
   * The content exclusion answer for what the run read: once it read marked content, the reason of the first such read
   * (`sensitive_memory` for session state).
   */
  exclusion(): string | false {
    return this.readMarked ? (this.reason ?? CONTENT_DROPPED_SENSITIVE_MEMORY) : false;
  }

  /**
   * Notes a read: `sensitive` by mark or stored labels; `marked` when the row carried the mark itself; `reason` the
   * drop reason it stands for (the first one is kept).
   */
  noteRead(sensitive: boolean, marked = sensitive, reason: string = CONTENT_DROPPED_SENSITIVE_MEMORY): void {
    if (!sensitive) return;
    this.readMarked = true;
    this.reason ??= reason;
    if (!marked || !this.options.contentCapture) return;
    this.readMarkedRow = true;
    try {
      this.options.onSensitiveRead?.();
    } catch {
      // Labels are best effort here: the run is already sensitive for content capture and marks what it writes.
    }
  }

  /**
   * v74 — marked content reached the run outside a node's read (the run's input, pinned or copied node outputs): as a
   * marked read, but the `sensitive` label goes on the run's output labels only (the caller labels the nodes).
   */
  noteCarried(reason: string): void {
    this.readMarked = true;
    this.reason ??= reason;
    if (this.options.contentCapture) this.readMarkedRow = true;
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

type SessionStores = Pick<WorkflowExecutionDependencies, "memoryStore" | "toolDataStore" | "sessionArtifactStore" | "knowledgeBaseStore">;

/**
 * The session stores with reads noted on `sensitivity` and writes marked by it. Arguments pass through as given: a write
 * that is not marked keeps its arguments exactly (an absent options argument stays absent).
 */
export function sensitivityTrackingSessionStores(dependencies: SessionStores, sensitivity: SessionSensitivity): SessionStores {
  const { memoryStore, toolDataStore, sessionArtifactStore, knowledgeBaseStore } = dependencies;
  return {
    ...(knowledgeBaseStore
      ? {
          // v74 — chunks a run adds while it is sensitive work are marked. Reads are noted by the knowledge base adapter
          // for the chunks it returns (a search reads every chunk to score them; only the ones it hands on count).
          knowledgeBaseStore: {
            ...knowledgeBaseStore,
            addKnowledgeBaseChunks: async (input: Parameters<typeof knowledgeBaseStore.addKnowledgeBaseChunks>[0]) =>
              input.sensitive === true || (await sensitivity.writeSensitive())
                ? await knowledgeBaseStore.addKnowledgeBaseChunks({ ...input, sensitive: true })
                : await knowledgeBaseStore.addKnowledgeBaseChunks(input),
            listKnowledgeBaseChunks: knowledgeBaseStore.listKnowledgeBaseChunks.bind(knowledgeBaseStore),
            getKnowledgeBase: knowledgeBaseStore.getKnowledgeBase.bind(knowledgeBaseStore),
            ...(knowledgeBaseStore.bm25SearchKnowledgeBase ? { bm25SearchKnowledgeBase: knowledgeBaseStore.bm25SearchKnowledgeBase.bind(knowledgeBaseStore) } : {})
          }
        }
      : {}),
    ...(memoryStore
      ? {
          memoryStore: {
            ...memoryStore,
            loadMessages: async (namespace: string, sessionId: string) => {
              // A store that loads the mark with the messages (one SELECT) is asked that way whether or not capture is
              // on, so with capture off a read of marked memory still marks what the run writes, at no extra query.
              if (memoryStore.loadMessagesMarked) {
                const loaded = await memoryStore.loadMessagesMarked(namespace, sessionId);
                if (loaded.messages.length > 0) sensitivity.noteRead(loaded.sensitive);
                return loaded.messages;
              }
              const messages = await memoryStore.loadMessages(namespace, sessionId);
              // A store without the v73 mark is left to label tracking: on tracked runs the engine reads its stored labels
              // (once, as before v73) and they keep the content out; an untracked run reads no labels at all.
              // A store that keeps the mark apart is asked for it only with capture on (one more query per read).
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
            ...(memoryStore.loadMessagesMarked
              ? {
                  loadMessagesMarked: async (namespace: string, sessionId: string) => {
                    const loaded = await memoryStore.loadMessagesMarked!(namespace, sessionId);
                    if (loaded.messages.length > 0) sensitivity.noteRead(loaded.sensitive);
                    return loaded;
                  }
                }
              : {}),
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
