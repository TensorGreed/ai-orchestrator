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

/** The session tables whose rows are keyed by namespace. */
export const PERSON_SESSION_TABLES = ["session_memory", "session_tool_cache", "session_artifacts"] as const;

/** A LIKE pattern that every key of `userId` matches (and possibly a few others; check with isPersonSessionOf). */
export function personSessionLikePattern(userId: string): string {
  return `project:%:${PERSON_SESSION_MARKER}${userId.length}:${userId}:%`;
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
