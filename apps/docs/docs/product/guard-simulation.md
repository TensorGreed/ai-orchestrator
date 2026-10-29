---
description: "Simulate a Guard profile change on recent golden and captured runs before saving it, and compare the outcome at every checkpoint with the current profile. No model calls."
---

# Guard policy simulation

Before you save a change to a guard profile, you can see what it would do to real traffic. **Simulate on recent traffic** replays the most recent [golden runs](./golden-runs.md) and [captured runs](./production-capture.md) still waiting in the inbox of the workflows that use the profile twice: once under the profiles in force now, and once with your changed settings. It then compares the guard's outcome at every checkpoint of the two replays. The result is your change **compared with the current profile**, whatever the profiles were when each run was recorded.

Nothing is saved and no model is called. Model calls are answered from each run's model tape and MCP calls from its cassette, the same way a [replay job](./golden-sets.md#replay-jobs) works.

Captured runs are replayed as they were stored: masked, with surrogates that the guard still detects as the same kind of data (an email surrogate is still an email). The simulation never promotes, changes or deletes a captured run, and captured runs still cannot be replayed on their own or added to a golden set until you promote them.

## Using it

1. Open **Security → Profiles & bindings** and pick a profile.
2. Change it in the editor (rules, detectors, thresholds or the JSON document).
3. Click **Simulate on recent traffic**, next to **Save new version**.

The result is one sentence first:

> Across 50 recent runs in 4 workflows: 3 newly blocked, 7 now masked, 0 no longer blocked.

**Details** opens the rest:

- Counts by data class and by detector.
- One row per workflow.
- The runs that changed, with each checkpoint (node name and channel) and its action under the current profile and under your change.

When no workflow you can read uses the profile, or none of them has a recorded run, the card says so. Record a few runs with **Save as golden run** (or `record: true` on the execute API), or turn on [production capture](./production-capture.md), and simulate again.

**Advanced** lets you simulate a saved version instead of the editor's contents. That version is compared with the current profile (its latest version) on the same runs, so you can see what moving to it, or back to it, would change.

## What counts as a change

A checkpoint is one guard check: a guard node, or a hook of an agent's guard (prompt, tool arguments, tool result, final answer), evaluated once on one piece of content. When several profiles apply (an enforced project profile and a workflow's own, for example), they are evaluated in order and the check stops at the first block. The checkpoint's action is the **combined action of all of them**: what the traffic got. A checkpoint therefore counts once, however many profiles it has and wherever the stack stopped. Shadow findings count as letting the content through.

Checkpoints are paired by node, channel, the agent's iteration and tool, and the occurrence at that place.

| Change | Meaning |
|---|---|
| **Newly blocked** | The current profile lets the content through (allow, or a rewrite); your change blocks it, sends it to review or asks for approval |
| **No longer blocked** | The current profile blocks it; your change lets it through |
| **Action changed** | Any other change, for example allow → mask (counted as **now masked**) or block → require approval |
| **Unchanged** | Same action |

A run counts once in each sentence figure, however many of its checkpoints changed. When an enforced profile already blocks the content, tightening another profile behind it changes nothing for the traffic, and the simulation says so.

## When a run diverges

A guard change can change what the model sees. For example, masking an email address in the prompt sends a different prompt. The recorded model answer then no longer matches, and the replay **never** falls back to a live model. The run stops there and is reported as **diverged at step k**, where k is the first model call (or tool call) the recording had no answer for.

A diverged run still counts its guard changes up to that point; the divergence itself is part of the impact.

A run is **not simulated** when the simulation cannot say anything about the guard:

- **The recording is stale.** The replay under the current profiles could not follow its recorded answers: the workflow changed since the run was recorded, the profiles in force now rewrite its content (for example the current profile masks something the recorded run sent through), or a `protect` token is random, so it differs on every replay. The difference would not be the guard's, so it is never counted as an impact. Record a fresh run.
- The replay with your change missed the tape although your change is identical to the current profile.
- The recording was deleted, or you can no longer read the workflow or simulate the profile.

The reason is shown next to the run.

## Which runs are used

- Workflows whose bindings resolve to the profile (a workflow or project binding, a project that enforces it, or the instance default when the profile is the built-in one), workflows with a Guard node that names the profile, and, when you simulate the built-in profile, workflows whose Guard node falls back to it because nothing is bound.
- Only workflows in projects you can read. With `PROJECT_ISOLATION=strict`, someone reading a simulation started by an admin sees only the workflows they can read, and nothing about the others: no counts, no names. Simulations that include none of their workflows are not listed for them.
- Recent recorded runs taken in turn from each workflow (newest first in each), so one busy workflow does not crowd out the others: up to 50 in all by default (`limit` in the API, capped by `REPLAY_SIMULATION_MAX_CASES`), and at most `REPLAY_JOB_MAX_CASES` from one workflow.
- Each workflow runs its published version when it has one, otherwise its draft. Both replays of a run use that same version.

The simulated profile replaces only that one profile, wherever the run would apply it. Other profiles in the run (an enforced project profile, another binding) still apply as they would in production.

## Who can simulate

Simulation is for people who can edit the profile: admins, and builders for profiles that are neither built-in nor enforced on a project. Viewers and operators do not see the button. Builders see it disabled on the built-in profile and on enforced profiles, with the reason. Admins can simulate the built-in profile's versions from **Advanced**. Reading a simulation needs the same rights. The starter's rights are checked again for every run the simulation replays: someone who loses them mid-way gets the remaining runs marked not simulated.

## Running one at a time

The current-profile side is pinned to the profile version the simulation started against (the card names it), so saving the profile while a simulation runs never mixes two baselines.

One simulation runs at a time per deployment. Starting another while one runs answers 409 with the running simulation's id. While another start is still being set up the 409 says so, without an id. Simulation replays also yield to release-gate and ordinary replay jobs: their runs always start first, and simulations never take every replay slot, so a simulation can wait behind a long queue of ordinary jobs.

An admin, or whoever started a simulation, can **Cancel** it from its card (or `POST /api/guard/simulations/:id/cancel`). Its replay jobs are canceled, it shows as canceled with no result, and the next simulation can start.

If the server restarts while a simulation runs, the simulation is marked **interrupted** and shows no result. Start it again.

## What it leaves behind

- **No guard activity.** The verdicts of a simulation stay in the simulation. They are not written to the guard events the Security page lists and counts.
- **No vault entries.** A `protect` action in a simulation tokenises through a vault that lives only as long as the simulation. Existing tokens are read, nothing new is stored.
- **Replay jobs** (one per workflow, with models from the tape and strict MCP replay) that are **never release proof**: a release gate never counts them, a publish that names one is refused, and they do not appear in the workflow's replay job list or the eval runs list, but can be opened by id.

The unsaved document is validated like a save (a bad document is refused with the field issues) and hashed, but never stored. Simulations and their replay jobs are deleted after 30 days.

## Cost

Two replays per run, both answered from the tape: no model is called and nothing is billed. Each run takes about twice the time of one tape replay.

## API

| Method and path | What it does |
|---|---|
| `POST /api/guard/profiles/:id/simulate` | Start a simulation. Body: `{ "document": { … } }` (unsaved) or `{ "version": 3 }`, optional `"limit"`. Answers 202 while running, or 200 with `?wait=true` once done |
| `GET /api/guard/simulations/:id` | The simulation: summary, sentence, per-workflow runs and checkpoints |
| `GET /api/guard/profiles/:id/simulations` | Recent simulations of the profile you may see (summaries only) |

Errors: 400 for an invalid document or both or neither of `document` and `version`; 403 for non-editors; 404 for an unknown profile, version or simulation (or one with none of your workflows); 409 while another simulation runs. Cancel: 403 unless you are an admin or started it.

A simulation's `status` is `running`, `completed`, `failed` (nothing could start) or `interrupted` (a replay job stopped early; no summary).

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `REPLAY_SIMULATION_MAX_CASES` | `200` | The most recorded runs one simulation replays |

## Limits

- Simulation uses recorded runs only; it cannot say what the profile would do to traffic that was never recorded.
