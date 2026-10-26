import type { Workflow, WorkflowListItem } from "@ai-orchestrator/shared";
import meta from "./fixtures/meta.json";
import workflows from "./fixtures/workflows.json";
import runs from "./fixtures/runs.json";
import responses from "./fixtures/responses.json";

/** One server-sent event of a recorded run, `t` ms after the run started. */
export interface RecordedFrame {
  event: string;
  data: unknown;
  t: number;
}

export interface RecordedRun {
  prompt: string;
  executionId: string;
  frames: RecordedFrame[];
}

export interface RecordedResponse {
  status: number;
  body: unknown;
}

/** A recorded answer to a write, with the request and the workflow graph it was made against. */
export interface RecordedWrite extends RecordedResponse {
  match: { workflowId: string; graph: Pick<Workflow, "nodes" | "edges">; request: Record<string, unknown> };
}

/** What `demo/record-fixtures.mts` writes: real API answers and run streams from a recording session. */
export interface DemoFixtures {
  meta: {
    recordedAt: string;
    user: { id: string; email: string; role: "admin" | "builder" | "operator" | "viewer" };
    /** A recorded workflow in the state of a new one; its per-workflow answers stand in for the visitor's workflows. */
    blankWorkflowId: string;
    note?: string;
  };
  workflows: { workflows: Workflow[]; workflowList: WorkflowListItem[] };
  runs: Record<string, RecordedRun>;
  responses: { get: Record<string, RecordedResponse>; post: Record<string, RecordedWrite> };
}

export const demoFixtures = { meta, workflows, runs, responses } as unknown as DemoFixtures;
