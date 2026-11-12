---
title: "Eval (LLM evaluation): definition and types"
term: "Eval"
topic: testing
definition: "A test for an AI system: give it an input, run it, and apply grading logic to the result to decide whether it succeeded."
description: "An eval is a test for an AI system: an input, a run, and grading logic. Capability vs regression evals and the graders they use."
related: [grader, regression-eval, golden-set, golden-run, llm-as-judge, pass-at-k]
guide: [/learn/testing/agent-evals]
---

# Eval

**A test for an AI system: give it an input, run it, and apply grading logic to the result to decide whether it succeeded.**

Model output varies from run to run and is often free text, so ordinary assertions are not enough on their own. An eval adds the parts a test needs for that. Anthropic's "Demystifying evals for AI agents" gives a shared vocabulary: a **task** is one test case with inputs and success criteria; each attempt is a **trial**; a <Term id="grader">grader</Term> is "logic that scores some aspect of the agent's performance"; the **transcript** is the full record of a trial, tool calls included.

## Two kinds

- **Capability evals** ask what the system can do. They start with a low pass rate and show progress.
- **Regression evals** ask whether it still does what it did before. They "should have a nearly 100% pass rate"; a failure means a change broke something.

## Graders

- **Code-based:** exact match, JSON Schema, the sequence of tool calls. Fast, cheap and repeatable, but brittle on free text.
- **Model-based:** an <Term id="llm-as-judge">LLM as judge</Term> grades against a rubric. Flexible, but not deterministic, and needs checking against people.
- **Human:** the most trusted and the slowest.

## Example

A refund agent has 40 tasks. One: "Customer asks for a refund on an order from last year." Pass means the agent called `lookup_order`, did not call `issue_refund`, and the answer cites the 90-day policy. The first two checks are code; the last is a rubric for a model grader.

## Common confusion

An eval is not a benchmark score. Public benchmarks compare models on someone else's tasks; your evals test your system on yours. For agents, run each task more than once: <Term id="pass-at-k">pass@k and pass^k</Term> measure different things.

## In L2M

[Golden sets](/product/golden-sets) are regression suites built from real runs: a replay job runs every case against a candidate version and scores it with scorers such as `status`, `json_equal`, `tool_sequence`, `budget` and `llm_judge`.

## Further reading

- [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) (anthropic.com)
