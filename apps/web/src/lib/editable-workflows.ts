import { useEffect, useMemo, useRef, useState } from "react";
import { fetchWorkflowAccess } from "./api";

type Role = "admin" | "builder" | "operator" | "viewer";

/** At most this many workflows' access is asked for at once (a page of runs names far fewer). */
const MAX_LOOKUPS = 50;

/**
 * Which of these workflows the signed-in person may edit (`GET /api/workflows/:id/access` canEdit): the run list's
 * replay controls (replay from a node, replay with the recorded MCP calls, golden runs) run the draft, so they are
 * shown only for those. Admins may edit every workflow; operators and viewers none. For a builder, a workflow's answer
 * is asked once and kept while the same person is signed in; until it is known the controls stay hidden.
 */
export function useEditableWorkflows(
  role: Role | undefined,
  userId: string | undefined,
  workflowIds: readonly string[]
): (workflowId: string) => boolean {
  // Answers belong to one signed-in person: another sign-in in the same tab starts over.
  const who = `${userId ?? ""}|${role ?? ""}`;
  const [known, setKnown] = useState<{ who: string; canEdit: Record<string, boolean> }>({ who, canEdit: {} });
  // Ids asked for and not answered yet, so a re-render does not ask again.
  const pending = useRef({ who, ids: new Set<string>() });
  if (pending.current.who !== who) pending.current = { who, ids: new Set<string>() };
  const asks = role === "builder";
  // A stable key, so a new array with the same ids does not ask again.
  const key = useMemo(() => [...new Set(workflowIds)].sort().join("\n"), [workflowIds]);
  const canEdit = known.who === who ? known.canEdit : {};

  useEffect(() => {
    if (!asks || !key) return;
    const missing = key
      .split("\n")
      .filter((id) => id && !(id in canEdit) && !pending.current.ids.has(id))
      .slice(0, MAX_LOOKUPS);
    if (missing.length === 0) return;
    const asked = pending.current;
    for (const id of missing) asked.ids.add(id);
    void Promise.all(
      missing.map(async (id) => {
        try {
          return [id, (await fetchWorkflowAccess(id)).canEdit] as const;
        } catch {
          return [id, false] as const;
        }
      })
    ).then((entries) => {
      for (const id of missing) asked.ids.delete(id);
      if (asked.who !== who) return;
      setKnown((current) => ({
        who,
        canEdit: { ...(current.who === who ? current.canEdit : {}), ...Object.fromEntries(entries) }
      }));
    });
  }, [asks, key, canEdit, who]);

  return useMemo(() => {
    if (role === "admin") return () => true;
    if (role !== "builder") return () => false;
    return (workflowId: string) => canEdit[workflowId] === true;
  }, [canEdit, role]);
}
