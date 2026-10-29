// W1: webhook -> set -> respond. Measures the per-run overhead on the API replicas (webhooks run inline there until
// queue dispatch exists).
import http from "k6/http";
import { check } from "k6";
import { BASE_URL, LOAD_RUN_ID, RATE, arrivalScenario, nextSeq, record, thresholds } from "./lib.js";

export const options = {
  scenarios: { w1: arrivalScenario("w1", RATE) },
  thresholds,
  summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max"]
};

export function w1() {
  const seq = nextSeq();
  const response = http.post(`${BASE_URL}/webhook/load-w1`, JSON.stringify({ loadRunId: LOAD_RUN_ID, seq }), {
    headers: { "content-type": "application/json" },
    tags: { name: "webhook" }
  });
  record(response, check(response, { "webhook 200": (r) => r.status === 200 }));
}
