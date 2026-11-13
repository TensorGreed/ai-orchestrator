---
title: "Replay testing for AI workflows"
term: "Replay"
topic: testing
definition: "Running a changed workflow or agent on the input of a recorded run, with its calls to the outside world answered from the recording, and comparing the result with the original."
description: "Replay reruns a changed workflow against a recorded run with outside calls answered from the recording, so tests have no side effects."
related: [golden-run, cassette, golden-set, release-gate, snapshot-mock]
guide: [/learn/testing/regression-testing-agents]
---

# Replay

**Running a changed workflow or agent on the input of a recorded run, with its calls to the outside world answered from the recording, and comparing the result with the original.**

Record-and-replay is an old testing idea: capture real traffic once, then serve it back. For agents it solves two problems. Tests cause no side effects, because a write tool is never really called. And they stop drifting, because the tools give the same answers every time.

A few terms come with it:

- **Recording.** The calls a run made and the answers it got, often kept as a <Term id="cassette">cassette</Term>.
- **Candidate.** The changed version under test: a new prompt, model or tool setting.
- **Matching.** How a call in the replay finds its recorded answer, for example by tool name and exact arguments.
- **Miss.** A call the recording has no answer for. A careful replay does not guess: it marks the result as not judged.
- **Live parts.** Usually the model runs live, because the model or prompt is what changed. When only the code after the model changed, model answers can come from the recording too, and the replay makes no model calls.

A model run live gives different answers from one run to the next, so a single replay can pass by luck. Repeating each case, which the evals literature calls running several trials, shows whether a pass is stable.

## Example

The recording holds `get_order({"id": "1182"})` and its answer. After a prompt change, the candidate calls `get_order({"order_id": "1182"})`. With strict matching the arguments differ, so there is no recorded answer. The replay reports the case as inconclusive, not as a pass or a failure.

## Common confusion

A replay is not a rerun. A rerun calls the real systems again, with today's data and real side effects. It is also not a mock: a mock returns answers someone wrote by hand, while a replay returns the answers the real systems gave.

## In L2M

[Replay](/product/golden-runs#what-a-replay-does) runs logic steps, calls models live by default (a replay job can answer them from the run's model tape instead), answers MCP calls only from the run's cassette, and answers code, HTTP, database and other outside steps from the recording. It never writes to deployment state, and it ends as pass, fail or inconclusive. `l2m replay run` exits with 4 on an inconclusive replay.

## Further reading

- [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) (Anthropic engineering, January 2026)
