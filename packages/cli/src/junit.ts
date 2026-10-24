/** JUnit XML for a replay job, for the test-report views of CI systems. */
import type { EvalCaseResult, EvalRunView } from "@ai-orchestrator/shared";
import { cleanServerText } from "./api";

// Characters XML 1.0 cannot carry, even escaped; cleanServerText already dropped most control characters.
const XML_INVALID = new RegExp(`[${String.fromCharCode(0xfffe, 0xffff)}]|[${String.fromCharCode(0xd800)}-${String.fromCharCode(0xdbff)}](?![${String.fromCharCode(0xdc00)}-${String.fromCharCode(0xdfff)}])|(?<![${String.fromCharCode(0xd800)}-${String.fromCharCode(0xdbff)}])[${String.fromCharCode(0xdc00)}-${String.fromCharCode(0xdfff)}]`, "g");

function esc(value: unknown): string {
  return cleanServerText(value)
    .replace(XML_INVALID, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

const seconds = (ms: number | null | undefined): string => ((ms ?? 0) / 1000).toFixed(3);

export interface JunitInput {
  run: (EvalRunView & { results?: EvalCaseResult[] }) | null;
  /** Why there is no usable run (a request failed, the job outlived --timeout). */
  message?: string | null;
  /** The job ran over an enforced release gate's sets: how the gate counts its cases. */
  gate?: {
    admitted: number;
    pending: number;
    required: number;
    pendingIds: ReadonlySet<string>;
    requiredIds: ReadonlySet<string>;
    /** Required cases that block a publish: failed, inconclusive (when errors count) or not run. */
    requiredFailingIds: ReadonlySet<string>;
  };
}

/**
 * One test suite per job, one test case per golden case. A failed case is a
 * `failure` (a regression); an inconclusive one an `error`; a job that did
 * not complete without any case results is one erroring `replay job` case,
 * so a pipeline that publishes the file always sees a red result. With an
 * enforced release gate, a required case that blocks a publish is a
 * `required_case` failure, a case pending admission says it does not count
 * yet, and the suite carries the admitted, pending and required counts.
 */
export function buildJunit(input: JunitInput): string {
  const run = input.run;
  const workflow = run?.workflowName || run?.workflowId || "workflow";
  const suiteName = `l2m replay ${workflow}`;
  const classname = `l2m.replay.${(run?.workflowId ?? "workflow").replace(/[^A-Za-z0-9_.-]/g, "_")}`;
  const cases: string[] = [];
  let failures = 0;
  let errors = 0;
  let skipped = 0;
  let totalMs = 0;
  const gate = input.gate;
  for (const result of run?.results ?? []) {
    const name = result.fixtureName ?? result.fixtureId;
    totalMs += result.durationMs ?? 0;
    const open = `    <testcase classname="${esc(classname)}" name="${esc(name)}" time="${seconds(result.durationMs)}"`;
    const requiredFailing = Boolean(gate?.requiredFailingIds.has(result.fixtureId));
    const note = gate?.pendingIds.has(result.fixtureId) ? "pending admission, not counted by the release gate: " : "";
    if (result.status === "pass") {
      cases.push(`${open}/>`);
    } else if (result.status === "fail" || (requiredFailing && result.status === "error")) {
      failures += 1;
      const failed = (result.score?.details ?? []).filter((detail) => !detail.pass);
      const lines = failed.map((detail) => `${detail.type}: ${detail.reason}`);
      if (result.status === "error") lines.unshift(result.error ?? "the case was inconclusive");
      const first = `${requiredFailing ? "required case: blocks a publish whatever the pass rate: " : note}${lines[0] ?? "the case failed"}`;
      cases.push(`${open}>\n      <failure message="${esc(first)}" type="${requiredFailing ? "required_case" : "regression"}">${esc(lines.join("\n"))}</failure>\n    </testcase>`);
    } else if (result.status === "error") {
      errors += 1;
      const text = `${note}${result.error ?? "the case was inconclusive"}`;
      cases.push(`${open}>\n      <error message="${esc(text)}" type="inconclusive">${esc(text)}</error>\n    </testcase>`);
    } else if (requiredFailing) {
      failures += 1;
      cases.push(`${open}>\n      <failure message="required case: it did not run" type="required_case">${esc(result.status)}</failure>\n    </testcase>`);
    } else {
      skipped += 1;
      cases.push(`${open}>\n      <skipped message="${esc(result.status)}"/>\n    </testcase>`);
    }
  }
  const finished = run && run.status === "completed";
  if (cases.length === 0 || (!finished && errors === 0 && failures === 0)) {
    // No case results, or the job stopped before every case ran: say so as a failing test.
    const why = input.message ?? run?.error ?? (run ? `the replay job is ${run.status}` : "the replay did not run");
    errors += 1;
    cases.push(`    <testcase classname="${esc(classname)}" name="replay job" time="0.000">\n      <error message="${esc(why)}" type="inconclusive">${esc(why)}</error>\n    </testcase>`);
  }
  const attributes = [
    `name="${esc(suiteName)}"`,
    `tests="${cases.length}"`,
    `failures="${failures}"`,
    `errors="${errors}"`,
    `skipped="${skipped}"`,
    `time="${seconds(totalMs)}"`,
    ...(run?.startedAt ? [`timestamp="${esc(run.startedAt)}"`] : [])
  ].join(" ");
  const properties = run
    ? [
        `      <property name="run" value="${esc(run.id)}"/>`,
        `      <property name="status" value="${esc(run.status)}"/>`,
        ...(run.candidate ? [`      <property name="candidate" value="${esc(run.candidate.kind)}"/>`, `      <property name="workflowHash" value="${esc(run.candidate.workflowHash)}"/>`] : []),
        ...(typeof run.candidate?.releaseEligible === "boolean" ? [`      <property name="releaseEligible" value="${run.candidate.releaseEligible}"/>`] : []),
        ...(run.candidate?.releaseIneligibleReasons ?? []).map((reason) => `      <property name="releaseIneligibleReason" value="${esc(reason)}"/>`),
        ...(gate
          ? [
              `      <property name="gateAdmittedCases" value="${gate.admitted}"/>`,
              `      <property name="gatePendingCases" value="${gate.pending}"/>`,
              `      <property name="gateRequiredCases" value="${gate.required}"/>`,
              `      <property name="gateRequiredFailing" value="${gate.requiredFailingIds.size}"/>`
            ]
          : [])
      ].join("\n")
    : "";
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<testsuites>`,
    `  <testsuite ${attributes}>`,
    ...(properties ? [`    <properties>`, properties, `    </properties>`] : []),
    ...cases,
    `  </testsuite>`,
    `</testsuites>`,
    ``
  ].join("\n");
}
