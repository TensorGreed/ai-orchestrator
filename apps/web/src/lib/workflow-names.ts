/**
 * Workflow names in the studio: a new or duplicated workflow is offered a name no other workflow in the list has, and
 * pickers tell apart workflows that share a name by a short id.
 */

const normalize = (name: string) => name.trim().toLowerCase();

/** "Workflow N" for a new workflow: the first N from the list's length + 1 that no workflow in `existing` uses. */
export function nextNewWorkflowName(existing: ReadonlyArray<string>): string {
  const taken = new Set(existing.map(normalize));
  let n = existing.length + 1;
  while (taken.has(normalize(`Workflow ${n}`))) n += 1;
  return `Workflow ${n}`;
}

/** The name offered for a copy of `source`: "<source> Copy", then "<source> Copy 2", and so on, until it is unused. */
export function copyWorkflowName(source: string, existing: ReadonlyArray<string>): string {
  const taken = new Set(existing.map(normalize));
  const base = `${source.trim() || "Workflow"} Copy`;
  if (!taken.has(normalize(base))) return base;
  let n = 2;
  while (taken.has(normalize(`${base} ${n}`))) n += 1;
  return `${base} ${n}`;
}

/** The first characters of an id, shown next to a name another workflow also has. */
export function shortWorkflowId(id: string): string {
  return id.replace(/^wf[-_]/, "").slice(0, 6);
}

/** Each workflow's label in a picker: its name, followed by "· <short id>" when another workflow in the list has the same name. */
export function workflowPickerLabels(workflows: ReadonlyArray<{ id: string; name: string }>): Map<string, string> {
  const counts = new Map<string, number>();
  for (const workflow of workflows) counts.set(normalize(workflow.name), (counts.get(normalize(workflow.name)) ?? 0) + 1);
  return new Map(
    workflows.map((workflow) => [
      workflow.id,
      (counts.get(normalize(workflow.name)) ?? 0) > 1 ? `${workflow.name} · ${shortWorkflowId(workflow.id)}` : workflow.name
    ])
  );
}
