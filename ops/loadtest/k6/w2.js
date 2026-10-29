// W2: an agent with three MCP tool calls (four model calls), sent through /enqueue and run by the workers.
import { RATE, arrivalScenario, enqueue, login, nextSeq, thresholds } from "./lib.js";

export const options = {
  scenarios: { w2: arrivalScenario("w2", RATE) },
  thresholds,
  summaryTrendStats: ["avg", "min", "med", "p(90)", "p(95)", "p(99)", "max"]
};

export function setup() {
  return login();
}

export function w2(session) {
  const seq = nextSeq();
  enqueue(session, "wf-load-w2-agent", seq, { userPrompt: `[run ${seq}] Where is order 42, what is the weather in Lisbon, and what is 2 + 5?` });
}
