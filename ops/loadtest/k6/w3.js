// W3: a code node (in-process JavaScript) and an HTTP node, sent through /enqueue and run by the workers.
import { RATE, arrivalScenario, enqueue, login, nextSeq, thresholds } from "./lib.js";

export const options = {
  scenarios: { w3: arrivalScenario("w3", RATE) },
  thresholds,
  summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max"]
};

export function setup() {
  return login();
}

export function w3(session) {
  enqueue(session, "wf-load-w3-code-http", nextSeq());
}
