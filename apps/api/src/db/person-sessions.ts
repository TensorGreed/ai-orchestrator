/**
 * Session keys kept to one person (run-scope.ts personSessionNamespace): `project:<n>:<projectId>:~person:<m>:<userId>:<ns>`.
 * The helpers here find a person's keys for a user deletion; matching is exact (the LIKE pattern only narrows the read).
 */

/** The marker that starts a person's part of a project session key. */
export const PERSON_SESSION_MARKER = "~person:";

/** The stored key for a namespace in a project. The length prefix keeps it unambiguous. */
export function projectSessionNamespace(projectId: string, namespace: string): string {
  return `project:${projectId.length}:${projectId}:${namespace}`;
}

/**
 * The stored key for a namespace in a project, kept to one person: the project prefix stays first (retention, legal
 * holds and exports find a project's sessions by it), then the person. The length prefixes keep it unambiguous, and
 * `projectSessionNamespace` is never asked for a namespace that starts with the marker (run-scope.ts sessionStoresFor).
 */
export function personSessionNamespace(userId: string, projectId: string, namespace: string): string {
  return projectSessionNamespace(projectId, `${PERSON_SESSION_MARKER}${userId.length}:${userId}:${namespace}`);
}

/**
 * A run's session owner is a user id, or, for a retry or replay of one person's run by someone else, a repeat owner
 * `repeat:<n>:<executionId>:<userId>`: still that person's key, under a namespace of its own (`~repeat:<executionId>:`),
 * so the repeat reads none of the person's memory, whatever its session templates say, and writes nowhere they read.
 */
const REPEAT_OWNER = /^repeat:(\d+):/;

export function repeatSessionOwner(userId: string, executionId: string): string {
  return `repeat:${executionId.length}:${executionId}:${userId}`;
}

/** The user a session owner belongs to. */
export function sessionOwnerUser(owner: string): string {
  const repeat = parseRepeatOwner(owner);
  return repeat ? repeat.userId : owner;
}

function parseRepeatOwner(owner: string): { executionId: string; userId: string } | null {
  const head = REPEAT_OWNER.exec(owner);
  if (!head) return null;
  const length = Number(head[1]);
  const start = head[0].length;
  if (owner[start + length] !== ":") return null;
  return { executionId: owner.slice(start, start + length), userId: owner.slice(start + length + 1) };
}

/** The stored key of `namespace` for a run with session owner `owner` in `projectId`. */
export function sessionOwnerKey(owner: string, projectId: string, namespace: string): string {
  const repeat = parseRepeatOwner(owner);
  return repeat
    ? personSessionNamespace(repeat.userId, projectId, `~repeat:${repeat.executionId}:${namespace}`)
    : personSessionNamespace(owner, projectId, namespace);
}

/** `value` for a LIKE pattern with a backslash as its escape character (the LIKE adds `ESCAPE` with a backslash). */
export function likeEscape(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/** The session tables whose rows are keyed by namespace. */
export const PERSON_SESSION_TABLES = ["session_memory", "session_tool_cache", "session_artifacts"] as const;

/**
 * A LIKE pattern (backslash escapes) that every key of `userId` matches, and possibly a few others: check each with
 * isPersonSessionOf.
 */
export function personSessionLikePattern(userId: string): string {
  return `project:%:${likeEscape(`${PERSON_SESSION_MARKER}${userId.length}:${userId}:`)}%`;
}

/** Is `namespace` a session key kept to `userId`? */
export function isPersonSessionOf(namespace: string, userId: string): boolean {
  const head = /^project:(\d+):/.exec(namespace);
  if (!head) return false;
  const projectLength = Number(head[1]);
  const afterProject = head[0].length + projectLength;
  if (namespace[afterProject] !== ":") return false;
  return namespace.startsWith(`${PERSON_SESSION_MARKER}${userId.length}:${userId}:`, afterProject + 1);
}
