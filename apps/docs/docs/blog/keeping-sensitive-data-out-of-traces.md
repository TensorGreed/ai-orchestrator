---
title: "Keeping sensitive data out of traces across runs"
description: "A sensitive mark that keeps data out of exported traces as it moves through agent memory, the tool cache, retries, error workflows and knowledge bases."
date: 2026-11-16
author: "The L2M team"
related: [data-labels, agent-memory, masking, rag]
socialCard: true
---

# Keeping sensitive data out of traces across runs

Turning on prompt capture in a tracing backend is one of the most useful things you can do when debugging an agent, and one of the riskiest. L2M's [OpenTelemetry content capture](/operations/opentelemetry#content-capture) is off by default, masks what it exports, and skips runs that handle data you declared sensitive. But a run is not where data lives. On 13 November 2026 we merged two changes that let a "sensitive" mark follow data out of the run that saw it: into <Term id="agent-memory">agent memory</Term>, the tool cache, retries, error workflows, pinned test data and knowledge bases. This post explains why that was needed and the design rules we ended up with. They apply to any system where a flag decides what may leave.

## The problem: state outlives the run

Content capture already knew which runs were "sensitive work". A run is sensitive when a node in it is marked **Sensitive output**, when it uses a secret flagged that way, when a Reveal node restores a protected value, or, on runs that track <Term id="data-labels">data labels</Term>, when a node's input is labelled sensitive. For such a run, spans are exported with timings but no content, and `l2m.content.dropped=sensitive` says why.

That check looks at one run. Consider a support agent with memory:

1. Monday, run A reads a customer's record through an MCP Tool node marked **Sensitive output**. Capture skips run A. The agent stores the conversation in session memory.
2. Tuesday, run B continues the same session. Nothing in run B is marked sensitive: it has a plain chat input and the same agent. The agent loads Monday's conversation from memory and sends it to the model.
3. With content capture on, run B's `chat` span exports its input messages, including what run A was careful never to export.

The sensitive data did not leak through the run. It leaked through state the run left behind. Session memory is one path; we found several more.

## Rule 1: mark at write time, check at read time

The fix is a form of taint tracking. Migration v73 adds a `sensitive` column (`INTEGER NOT NULL DEFAULT 0`) to the three session stores: `session_memory`, `session_tool_cache` and `session_artifacts`. When sensitive work writes a row, the row is marked. When a later run reads a marked row, it becomes sensitive from that point on: its spans export no content, with `l2m.content.dropped=sensitive_memory`, and **what it writes is marked in turn**.

That last clause is what makes it a chain and not a single hop. Run B reads marked memory and writes a summary to the tool cache; run C reads the summary. Without propagation, run C would export it.

## Rule 2: mark whether or not anyone is looking

We could have marked rows only while content capture is on, since that is the only feature that reads the mark. It would have been wrong. Capture is a setting an admin can turn on at any time. If marks were written only while it was on, turning it on would make every row written in the months before look clean, and the first run to read one would export it.

So marks are written whatever the capture setting. With capture off, reading a marked row changes nothing you can see: no label is added, tool rules behave exactly as before, and nothing is exported anyway. But a run that reads a marked row still marks what it writes, so the mark keeps following the data, ready for the day capture is turned on.

The general rule: **record facts about data when the data is written, not when a policy that cares about them is enabled.** A policy can change in a second; you cannot go back and learn what you did not record.

## Rule 3: the mark lives in the row

Where to keep the mark is a performance question with a correctness side. A separate table of "sensitive session ids" would need a second query on every memory read, and a second place to keep in sync on delete, retention and erasure.

The mark is a column in the row itself, and since the v74 release a memory read loads the messages and the mark in the same query, so marks cost no extra query per read. Because the mark is part of the row, everything that already handles rows handles marks for free: retention and erasure delete them with the row, a legal hold holds them, `db:export`, `db:import` and `db:copy` carry the column wherever they carry the row (the tool cache is not part of `db:export`), and a replay's memory seed keeps it.

What it does cost: on a run's first write to session state, L2M checks the run's nodes, sub-workflows and registered MCP servers for declared sensitive sources, the same check capture makes at run start. A server or sub-workflow that cannot be checked counts as sensitive.

## Rule 4: marks only go one way

A mark is never cleared while its row exists, even after the sensitive turns scroll out of the memory window the agent sends to the model. This is deliberate. Deciding that data is no longer sensitive is a judgement no code path in a run can make safely, so we did not give it one. The cost is real: a long-lived session that once held sensitive data exports no content for good. The way out is explicit: delete the session's memory and start over.

In information-flow terms, there is no automatic declassification. If you build something similar, decide early who may lower a mark, because every automatic way to do it becomes the path a leak takes.

## The other ways content travels

Session state was the first path. Migration v74 marks two more kinds of row, `execution_history` (run records) and `knowledge_base_chunks`, and covers the ways a later run starts from an earlier run's content:

| Path | What can carry content | Drop reason |
| --- | --- | --- |
| Error workflows | The failed run's data, handed to its error workflow | `sensitive_run_data` |
| Retries and reruns | A retry, a run from a source execution, a single-node run with node outputs copied from a run | `sensitive_run_data` |
| Pinned data | A node's output from a run, pinned as test data | `sensitive_run_data` |
| Knowledge bases | Chunks a sensitive run added through a RAG Retrieve node, found by a later search | `sensitive_knowledge` |

Each one taught something.

**Error workflows** run because another run failed, and their input is that run's data. A sensitive run's failure must not become a non-sensitive run's input. The failing run is checked only when it has an error workflow, so ordinary failures pay nothing.

**Pins** were the subtle one. A builder pins a node's output from a real run to test the next node without calling the model again. If that run was sensitive, the pinned data is too. The mark is stored with the workflow (`pinnedDataSensitive`) and stays while the node is pinned, even when the data is edited. Our first version kept the mark only while the data was unchanged; review caught the flaw, since editing one field of a sensitive payload leaves the rest of it in place. And a save from an older client that does not know the field cannot clear it either. To clear the mark, remove the pin. Data pinned by hand, not from a run, is your own input and is not marked.

**Knowledge bases** are shared across sessions and users, so a mark there matters more. Only chunks a search actually returns count, so one marked chunk in a large base does not make every search sensitive.

## Rule 5: fail closed on what you cannot know

Several review findings were variants of "we did not know, so we assumed fine". Each now assumes the opposite:

- **Unfinished runs.** A run record written before its run finished counts as sensitive until the final write says otherwise. A run ended by a cancel or a restart never wrote that, so a retry of it cannot export its content.
- **The version that ran.** A production run ran a published version, not today's draft. The check reads the version that actually ran, as well as the draft.
- **Unreadable sources.** A registered MCP server that cannot be checked at run start makes the whole run sensitive.
- **Mixed clusters.** In a queue-based deployment, an older worker would not understand the mark. Runs that use marked pins, or start from a sensitive run's content, go only to workers that understand it, and run inline otherwise.
- **Replay.** Runs that use a marked pin or start from a sensitive run's content are never recorded for replay, wherever they run.

## Limits

- Nothing is backfilled. Rows written before v73 (session state) or v74 (runs and chunks) carry no mark. For session rows, stored labels that say sensitive still count when read, but memory written by a sensitive run that tracked no labels before the upgrade is not covered.
- Rolling the schema back below v73 or v74 drops the marks.
- Chunks added through the knowledge base API, not by a run, are not marked.
- The mark does not change what memory holds or what the model sees. With capture on, a read of a marked row also adds the `sensitive` label, which tool rules and destination checks then act on; with capture off it only decides what later runs mark.

## Try it in L2M

Content capture and marks are covered on the [OpenTelemetry page](/operations/opentelemetry#session-state-from-sensitive-runs), with every drop reason. [Data labels and destinations](/product/data-labels-and-destinations) explains labels and the **Sensitive output** mark, the [agent memory guide](/learn/agents/agent-memory) explains the stores that carry it, and the [webhook agent with memory](/recipes/webhook-agent-with-memory) recipe shows a session in use. For the tracing side, read [Tracing AI agents with OpenTelemetry, end to end](/blog/opentelemetry-tracing-for-ai-agents); for the risk itself, [Sensitive data in prompts](/learn/security/sensitive-data-in-prompts).

## Further reading

- [LLM02:2025 Sensitive Information Disclosure](https://genai.owasp.org/llmrisk/llm022025-sensitive-information-disclosure/) (OWASP Top 10 for LLM Applications)
- [GenAI spans](https://github.com/open-telemetry/semantic-conventions/blob/v1.41.0/docs/gen-ai/gen-ai-spans.md), v1.41.0: message attributes are opt-in and "likely to contain sensitive information" (OpenTelemetry)
- Pull requests: [#212 marks on session state (v73)](https://github.com/TensorGreed/ai-orchestrator/pull/212), [#213 marks on runs, pins and knowledge base chunks (v74)](https://github.com/TensorGreed/ai-orchestrator/pull/213) (GitHub)
