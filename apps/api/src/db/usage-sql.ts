/**
 * The usage views' execution counts, average durations and recent-executions list read only execution rows: the
 * own row of a sub-workflow (trigger type `sub_workflow`, written for an async child that ended after its run was
 * recorded, or for what a run held when it paused) is spend, not an execution. Its spend still counts in every sum
 * and in budgets. The same SQL on SQLite and Postgres.
 */
export const SUB_WORKFLOW_USAGE_TRIGGER = "sub_workflow";

/** True for a row that is an execution (trigger_type may be NULL). */
export const USAGE_EXECUTION_ROW = `COALESCE(trigger_type, '') <> '${SUB_WORKFLOW_USAGE_TRIGGER}'`;

export const USAGE_EXECS = `COALESCE(SUM(CASE WHEN ${USAGE_EXECUTION_ROW} THEN 1 ELSE 0 END), 0)`;

export const USAGE_AVG_DURATION = `AVG(CASE WHEN ${USAGE_EXECUTION_ROW} THEN duration_ms END)`;
