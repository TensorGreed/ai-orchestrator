---
title: "AI agent evals: tasks, graders, traces and pass rates"
sidebarTitle: "Agent evals"
description: "What an agent eval is: tasks, trials, graders and transcripts, capability vs regression evals, pass@k vs pass^k, and how to write your first 20 cases."
level: intermediate
about: eval
related: [eval, golden-run, golden-set, pass-at-k]
socialCard: true
---

# AI agent evals

An <Term id="eval">eval</Term> is an automated test for an AI system: give it an input, let it run, and grade what it did. For an agent, "what it did" is more than the final answer. It includes the tools it called, the arguments it passed and the state it left behind. Good agent evals grade the outcome first, read the transcript to find out why, and run each case more than once, because the same agent can pass on one try and fail on the next.

## Why agents are harder to test than one model call

A single model call is a function: text in, text out. You can compare the output with an expected answer and move on. An agent is a loop. The model reads the task, asks for a tool, reads the result, and decides the next step from what it just learned. That loop makes testing harder in four ways:

- **Many paths, one goal.** Two runs can call different tools in a different order and both be correct. A test that expects one exact sequence of steps fails good runs.
- **Side effects.** A tool call can send an email, write a row or open a ticket. Running a test against live tools changes real systems.
- **Nondeterminism.** The same prompt can produce a different plan on the next try. One passing run proves little about the next hundred.
- **Errors compound.** A wrong tool choice in step two shapes every step after it. A small change in a prompt can show up as a failure five steps later.

None of this means agents cannot be tested. It means the test needs a richer idea of "pass" than string equality.

## The vocabulary

Anthropic's engineering post on agent evals ([Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents), January 2026) uses a small set of terms that are worth adopting, because they separate things people often mix up:

| Term | What it means | Example |
|---|---|---|
| Task | One test case: defined inputs and success criteria. | "Refund order 1042; it is within the 30-day window." |
| Trial | One attempt at a task. Run a task several times and you have several trials. | Three runs of the refund task. |
| Grader | Logic that scores one aspect of a trial. A task can have several. | "Did the refund tool get called with order 1042?" |
| Transcript | The full record of a trial: messages, tool calls, results, intermediate output. Also called a trace. | The list of model turns and tool calls in the run. |
| Outcome | The final state of the environment when the trial ends. | The order's status is `refunded` in the database. |
| Evaluation harness | The code that runs tasks, collects transcripts and applies graders. | Your test runner. |
| Evaluation suite | A collection of tasks that measures one capability or behaviour. | "Refund handling: 25 tasks." |

The split between transcript and outcome matters most. The agent can say "I refunded the order" while the outcome shows it did not. Grade the outcome when you can; use the transcript to explain failures.

## Graders: code, model, human

There are three kinds of grader, and most suites mix them.

**Code-based graders** check things a program can decide: an exact or fuzzy string match, a JSON field, a unit test over generated code, whether a given tool was called. They are fast, cheap and repeatable. They are also brittle: a correct answer phrased differently can fail.

**Model-based graders** ask a language model to judge the output against a rubric, often called LLM-as-judge. They handle open-ended answers ("is this summary faithful to the source?") that code cannot. They cost more, are not fully deterministic, and need calibrating against human judgement before you trust them.

**Human graders** are the reference the other two are calibrated against: an expert reads the transcript and decides. They are slow and expensive, so use them to build and check the other graders, and to spot-check results.

A practical rule: use a code grader wherever the answer has a checkable fact in it, a model grader only for qualities code cannot see, and a human to check both now and then.

## Capability evals and regression evals

The same harness answers two different questions, and it helps to keep them apart.

A **capability eval** asks "what can this agent do?" It holds hard tasks the agent does not solve yet. A low pass rate is expected; the number tells you whether a change made the agent better.

A regression eval asks "does the agent still do everything it used to?" It holds tasks the agent already passes, so its pass rate should sit near 100%. A drop means a change broke something. When a capability task passes reliably, move it into the regression suite so it stays fixed.

Most teams need the regression suite first. It is what lets you change a prompt, swap a model or upgrade a tool without fear. The next guide, [regression testing AI agents](/learn/testing/regression-testing-agents), covers it in depth.

## pass@k and pass^k

Because an agent can succeed on one trial and fail on the next, a single run is a weak signal. Run each task k times and summarise the trials in one of two ways:

- **pass@k**: the chance that **at least one** of k trials succeeds. Use it when one success is enough, for example when a person reviews several drafts and picks the best.
- **pass^k**: the chance that **all** k trials succeed. Use it when every run must work, for example a customer-facing agent that handles refunds.

The two move in opposite directions as k grows. The Anthropic post gives an example: an agent that succeeds 75% of the time per trial passes three trials in a row (pass^3) with probability 0.75 × 0.75 × 0.75, about 42%. Run the same numbers the other way and its pass@3 is 1 − 0.25 × 0.25 × 0.25, about 98%. Same agent, very different numbers, so say which one you report.

For a regression suite, pass^k is usually the honest number. A case that passes on two tries out of three is flaky, and a flaky case in a release check is a coin toss.


## Your first 20 cases

You do not need hundreds of tasks to start. The Anthropic post suggests 20 to 50 simple tasks drawn from real failures. A way to get there:

1. **Write down the checks you already do by hand** before a release. Each one is a task.
2. **Turn every bug report into a task.** The input that broke the agent, plus what it should have done.
3. **Write success criteria a stranger could apply.** "Answers correctly" is not a criterion; "the reply names the refund amount and the order number" is.
4. **Include cases where the agent should not act**: a refund outside the window, a request it should decline, a question it should answer without calling a tool. Without them, a suite rewards an agent that always acts.
5. **Check the task, not just the agent.** If a task fails on every trial, the task or its grader is often wrong. Read the transcripts before you blame the agent.
6. **Read transcripts regularly**, including passing ones. That is how you find graders that accept wrong answers or reject right ones.

Keep each task small and focused. A task that tests five things at once tells you something failed, not what.

## Scoring tool use, not just the answer

For an agent, the tool calls are often where the real behaviour is. Useful checks on the transcript:

- **The right tool was called** for the task, and a forbidden one was not (for example, no write tool on a read-only question).
- **The arguments were right**: the order id, the amount, the recipient.
- **No unnecessary calls.** An agent that calls ten tools for a one-tool question is slow and costly even when it ends up right.

Grade the outcome first and the path second. Checking an exact sequence of steps punishes an agent that found another valid route. Check the steps that matter (the write happened once, with the right arguments) and leave the rest free.

Security behaviour is testable the same way. A task can feed the agent a document with an instruction hidden in it and pass only if no write tool was called; see [prompt injection](/learn/security/prompt-injection) for the attack this tests.

## Evals in L2M

L2M, a self-hosted workflow builder and agent runtime, builds its evals from real runs:

- A <Term id="golden-run">golden run</Term> is a finished run you saved as the reference: its input, each step's result and its MCP tool calls, plus a recording of its MCP and model calls if you turned on **Record MCP calls** before the run. A <Term id="golden-set">golden set</Term> groups golden runs for one workflow, and a <Term id="replay">replay</Term> job runs the whole set against a changed version ([golden sets](/product/golden-sets)).
- Each case is graded by [scorers](/product/golden-sets#scorers). The code graders include `status`, `json_equal`, `json_schema`, `contains`, `regex`, `text_similarity` (word overlap), `budget` (cost, tokens and latency) and `tool_sequence`. The model grader is `llm_judge`, with a rubric, absolute or pairwise mode and up to five votes; it is off until the deployment turns judges on. RAG answers have their own scorers, such as faithfulness and context recall; faithfulness also needs judges turned on ([RAG eval scorers](/nodes/knowledge-bases#rag-specific-eval-scorers-phase-9-5)).
- `tool_sequence` grades the path: the same calls in the same order, the expected calls in order with extras allowed, the same set of tools, or every expected tool with extras allowed. In the two ordered modes it can also compare arguments, exactly or by key names; by default it ignores them. Its `forbiddenTools` option fails a case that called a tool it must not. A separate scorer, `guard_outcome`, checks that a content rule caught a planted attack or let a harmless input through.
- A replay job can run each case up to five times and decide it with `all`, `majority` or `any`. `all` is the per-case version of pass^k and `any` of pass@k; L2M reports which cases passed and marks a case whose repeats disagree as flaky, but it does not compute a pass@k or pass^k figure for you.

Without any scorers, a case passes when its status did not get worse and its output matches the golden run's. For an agent whose answers vary in wording, add `text_similarity`, `json_schema` or a judge instead, or every reworded answer counts as a regression.

In the live demo, an FAQ workflow's new version adds a prefix to every answer. Its recorded replay job failed all three cases on the output comparison, which is exactly what a regression suite should do with an unreviewed change to the output.

<TryInDemo workflow="wf-demo-faq-release" recorded />

## Further reading

- [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) (Anthropic engineering, January 2026)
- [AgentDojo: a dynamic environment to evaluate prompt injection attacks and defenses for LLM agents](https://arxiv.org/abs/2406.13352) (Debenedetti et al., arXiv 2406.13352)
