// Shared helpers for the scale harness workloads. Run by ops/loadtest/run.sh in the grafana/k6 container.
//
// Environment: BASE_URL (http://nginx inside the compose network), LOAD_RUN_ID (tags every run so run.sh can match
// k6's count against execution_history), RATE (runs per second), DURATION (k6 duration, e.g. 60s),
// ADMIN_EMAIL / ADMIN_PASSWORD (the bootstrap admin).
import http from "k6/http";
import exec from "k6/execution";
import { check, fail } from "k6";
import { Counter } from "k6/metrics";

export const BASE_URL = (__ENV.BASE_URL || "http://nginx").replace(/\/+$/, "");
export const LOAD_RUN_ID = __ENV.LOAD_RUN_ID || `adhoc-${Date.now()}`;
export const RATE = Number(__ENV.RATE || "5");
export const DURATION = __ENV.DURATION || "60s";

export const runsAccepted = new Counter("runs_accepted");
export const runsRejected = new Counter("runs_rejected");
export const runsThrottled = new Counter("runs_throttled");

/** Constant arrival rate: RATE runs per second whatever the latency, so a slow system shows up as queueing. */
export function arrivalScenario(exec, rate, extra = {}) {
  const perSecond = Math.max(1, Math.round(rate));
  return {
    executor: "constant-arrival-rate",
    exec,
    rate: perSecond,
    timeUnit: "1s",
    duration: DURATION,
    preAllocatedVUs: Math.min(500, perSecond * 4),
    maxVUs: Math.min(2000, perSecond * 40),
    ...extra
  };
}

export const thresholds = {
  // Reported, not enforced: run.sh records k6's exit code and the reconcile result decides.
  http_req_failed: [{ threshold: "rate<0.001", abortOnFail: false }]
};

/** A unique run number across all scenarios of this test (offset keeps scenarios apart). */
export function nextSeq(offset = 0) {
  return offset + exec.scenario.iterationInTest;
}

export function login() {
  const email = __ENV.ADMIN_EMAIL || "admin@example.com";
  const password = __ENV.ADMIN_PASSWORD || "scale-harness-password";
  const response = http.post(`${BASE_URL}/api/auth/login`, JSON.stringify({ email, password }), {
    headers: { "content-type": "application/json" },
    tags: { name: "login" }
  });
  if (response.status !== 200) fail(`login failed: ${response.status} ${response.body}`);
  const cookie = response.cookies.ao_session?.[0]?.value;
  if (!cookie) fail("login answered without an ao_session cookie");
  return { cookie: `ao_session=${cookie}` };
}

/** POST /api/workflows/:id/enqueue with the run tag in the input and in customData. */
export function enqueue(session, workflowId, seq, body = {}) {
  const tag = { loadRunId: LOAD_RUN_ID, seq };
  const response = http.post(
    `${BASE_URL}/api/workflows/${workflowId}/enqueue`,
    JSON.stringify({ input: { ...tag }, customData: { ...tag }, ...body }),
    { headers: { "content-type": "application/json", cookie: session.cookie }, tags: { name: "enqueue" } }
  );
  record(response, check(response, { "enqueue 200": (r) => r.status === 200 && r.json("queued") === true }));
  return response;
}

export function record(response, ok) {
  if (ok) runsAccepted.add(1);
  else if (response.status === 429) runsThrottled.add(1);
  else runsRejected.add(1);
}
