---
title: "pass@k vs pass^k: two ways to score agent tests"
term: "pass@k and pass^k"
topic: testing
definition: "Two ways to score k tries of the same test: pass@k is the chance that at least one try succeeds, pass^k the chance that all k succeed."
description: "pass@k is the chance of at least one success in k tries; pass^k the chance all k succeed. Where each comes from, how to estimate them, which to report."
related: [eval, regression-eval, golden-set, replay, grader]
guide: [/learn/testing/agent-evals]
---

# pass@k and pass^k

**Two ways to score k tries of the same test: pass@k is the chance that at least one try succeeds, pass^k the chance that all k succeed.**

A model can pass a task on one try and fail it on the next, so one run per task says little. Both metrics summarise several tries per task, then average over the tasks. They answer opposite questions:

- **pass@k** asks "can it do this at all?" It comes from code generation, where unit tests can pick the one working answer out of k. Chen et al. (2021) used it with their HumanEval benchmark, building on earlier work by Kulal et al., and gave an unbiased way to estimate it.
- **pass^k** asks "will it do this every time?" Yao et al. proposed it in 2024 with τ-bench, a benchmark of agents that talk to a user and call tools, as the better fit for agent tasks that need reliability and consistency, such as customer service.

At k = 1 the two are the same number. As k grows, pass@k can only rise and pass^k can only fall, so the gap widens.

## Estimating them

Run each task n times (n at least k) and count the c successful runs. The papers estimate each per task, then average over all tasks:

- pass@k = 1 − C(n − c, k) / C(n, k)
- pass^k = C(c, k) / C(n, k)

C(a, b) is the number of ways to choose b of a. Chen et al. used n = 200 and k up to 100, and showed that the tempting shortcut 1 − (1 − p)^k, with p the share of runs that passed, is biased.

## Example

A task ran 10 times and passed 7. For k = 3:

- pass@3 = 1 − C(3, 3) / C(10, 3) = 1 − 1/120 ≈ 99%
- pass^3 = C(7, 3) / C(10, 3) = 35/120 ≈ 29%

Same runs, very different headlines. Report which one you mean, and the k.

## Common confusion

pass@k is not a success rate. An agent that works one time in five has a pass@10 of nearly 90%. For anything that runs unattended, such as refunds, deployments or customer replies, pass^k (or at least pass@1) is the honest number. The τ-bench paper shows how low it can go: it reports that state-of-the-art function-calling agents were "quite inconsistent (pass^8 &lt;25% in retail)".

## In L2M

L2M does not compute pass@k or pass^k. The nearest feature is per-case repeats in [replay jobs](/product/golden-sets#candidates-and-comparison): `repeats` (1 to 5) runs each <Term id="golden-set">golden set</Term> case several times, and `aggregate` decides the case. `all`, the default, passes a case only when every repeat passes, which is the per-case form of pass^k; `any` passes it on one success, the per-case form of pass@k; `majority` sits in between. Each is a pass or fail for one case with n = k runs, not an estimate across tasks. A case whose repeats disagree is marked flaky.

## Further reading

- [Chen et al., Evaluating Large Language Models Trained on Code](https://arxiv.org/abs/2107.03374) (arXiv, 2021): pass@k and its unbiased estimator
- [Yao et al., τ-bench: A Benchmark for Tool-Agent-User Interaction in Real-World Domains](https://arxiv.org/abs/2406.12045) (arXiv, 2024): pass^k
- [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) (Anthropic engineering, January 2026)
