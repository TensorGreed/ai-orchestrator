// W4: a mix. 80% of runs are /enqueue (W3), 20% are streamed manual runs of the W2 agent.
//
// The streamed part measures queue dispatch (EXECUTION_DISPATCH=queue), where a streamed run executes on a worker and
// its events are relayed to the API replica holding the connection. run.sh sets W4_STREAMED=1 only when the server
// reports queue dispatch; otherwise the streamed scenario is left out and the run is enqueue-only.
import http from "k6/http";
import { check } from "k6";
import { Counter } from "k6/metrics";
import { BASE_URL, LOAD_RUN_ID, RATE, arrivalScenario, enqueue, login, nextSeq, record, thresholds } from "./lib.js";

const STREAMED = __ENV.W4_STREAMED === "1";
const STREAM_SEQ_OFFSET = 10000000;
const streamedRuns = new Counter("streamed_runs_accepted");

const scenarios = { enqueue: arrivalScenario("enqueueRun", STREAMED ? RATE * 0.8 : RATE) };
if (STREAMED) scenarios.stream = arrivalScenario("streamRun", Math.max(1, RATE * 0.2));

export const options = {
  scenarios,
  thresholds,
  summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max"]
};

export function setup() {
  if (!STREAMED) console.log("W4: streamed runs skipped (the server does not dispatch runs through the queue)");
  return login();
}

export function enqueueRun(session) {
  enqueue(session, "wf-load-w3-code-http", nextSeq());
}

export function streamRun(session) {
  const seq = nextSeq(STREAM_SEQ_OFFSET);
  const tag = { loadRunId: LOAD_RUN_ID, seq };
  const response = http.post(
    `${BASE_URL}/api/workflows/wf-load-w2-agent/execute/stream`,
    JSON.stringify({ user_prompt: "Where is order 42?", variables: { ...tag }, customData: { ...tag } }),
    { headers: { "content-type": "application/json", accept: "text/event-stream", cookie: session.cookie }, tags: { name: "stream" }, timeout: "180s" }
  );
  const ok = check(response, {
    "stream 200": (r) => r.status === 200,
    "stream completed": (r) => typeof r.body === "string" && /^event: result$/m.test(r.body)
  });
  record(response, ok);
  if (ok) streamedRuns.add(1);
}
