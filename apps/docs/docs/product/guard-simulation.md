# Guard policy simulation

Before you save a change to a guard profile, you can see what it would have done to real traffic. **Simulate on recent traffic** replays the most recent [golden runs](./golden-runs.md) of the workflows that use the profile with your changed settings. It then compares each guard verdict with what the run actually recorded.

Nothing is saved and no model is called. Model calls are answered from each run's model tape and MCP calls from its cassette, the same way a [replay job](./golden-sets.md#replay-jobs) works.

## Using it

1. Open **Security → Profiles & bindings** and pick a profile.
2. Change it in the editor (rules, detectors, thresholds or the JSON document).
3. Click **Simulate on recent traffic**, next to **Save new version**.

The result is one sentence first:

> Across 50 recent runs in 4 workflows: 3 newly blocked, 7 now masked, 0 no longer blocked.

**Details** opens the rest:

- Counts by data class and by detector.
- One row per workflow.
- The runs that changed, with each checkpoint (node and channel) and its action before and after.

When no workflow you can read uses the profile, or none of them has a recorded run, the card says so. Record a few runs with **Save as golden run** (or `record: true` on the execute API) and simulate again.

**Advanced** lets you simulate a saved version instead of the editor's contents. The recorded runs are compared with that version, so you can see what moving to it, or back to it, would change.

## What counts as a change

Each guard checkpoint of a run (a guard node, or a hook of an agent's guard: prompt, tool arguments, tool result, final answer) is paired with the same checkpoint in the replay. Pairing uses the node, the channel and the occurrence. The checkpoint's action is the most severe action of its verdict. Shadow findings count as letting the content through.

| Change | Meaning |
|---|---|
| **Newly blocked** | The recording let the content through (allow, or a rewrite); the simulation blocks it, sends it to review or asks for approval |
| **No longer blocked** | The recording blocked it; the simulation lets it through |
| **Action changed** | Any other change, for example allow → mask (counted as **now masked**) or block → require approval |
| **Unchanged** | Same action |

A run counts once in each sentence figure, however many of its checkpoints changed.

Golden runs recorded before this feature do not carry the data class of each finding. Their detector counts still work, but their data class shows as unknown.

## When a run diverges

A guard change can change what the model sees. For example, masking an email address in the prompt sends a different prompt. The recorded model answer then no longer matches, and the replay **never** falls back to a live model. The run stops there and is reported as **diverged at step k**, where k is the first model call (or tool call) the recording had no answer for.

A diverged run still counts its guard changes up to that point; the divergence itself is part of the impact.

A run is **not simulated** when the replay could not say anything about the guard. This happens when the recording was deleted, has no model tape, or you can no longer run the workflow. It also happens when the workflow changed since the recording and the tape missed without any guard verdict changing. The reason is shown next to the run.

## Which runs are used

- Workflows whose bindings resolve to the profile (a workflow or project binding, a project that enforces it, or the instance default when the profile is the built-in one), plus workflows with a Guard node that names the profile.
- Only workflows in projects you can read. With `PROJECT_ISOLATION=strict`, someone reading a simulation started by an admin sees only their own projects' workflows; the rest is counted as hidden.
- The newest recorded runs across those workflows, up to 50 by default (`limit` in the API, capped by `REPLAY_SIMULATION_MAX_CASES`).
- Each workflow runs its published version when it has one, otherwise its draft.

The simulated profile replaces only that one profile, wherever the run would apply it. Other profiles in the run (an enforced project profile, another binding) still apply as they would in production.

## Who can simulate

Simulation is for people who can edit the profile: admins, and builders for profiles that are neither built-in nor enforced on a project. Viewers and operators do not see the button. The built-in profile is read-only in the editor, so it has no button either; admins can simulate one of its versions through the API. Reading a simulation needs the same rights.

## Replay jobs and retention

One simulation starts one replay job per workflow, with models from the tape, strict MCP replay, and the simulated profile. These jobs:

- are **never release proof**: they do not count towards a release gate;
- do not appear in the workflow's replay job list, but can be opened by id;
- record guard events under the simulated profile id at version `0` when the profile is an unsaved document, with the document's hash.

The unsaved document is validated like a save (a bad document is refused with the field issues) and hashed, but never stored. Simulations and their replay jobs are deleted after 30 days.

## API

| Method and path | What it does |
|---|---|
| `POST /api/guard/profiles/:id/simulate` | Start a simulation. Body: `{ "document": { … } }` (unsaved) or `{ "version": 3 }`, optional `"limit"`. Answers 202 while running, or 200 with `?wait=true` once done |
| `GET /api/guard/simulations/:id` | The simulation: summary, sentence, per-workflow runs and checkpoints |
| `GET /api/guard/profiles/:id/simulations` | Recent simulations of the profile (summaries only) |

Errors: 400 for an invalid document or both or neither of `document` and `version`; 403 for non-editors; 404 for an unknown profile, version or simulation.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `REPLAY_SIMULATION_MAX_CASES` | `200` | The most recorded runs one simulation replays |

## Limits

- **SQLite only.** On Postgres the simulation routes answer 501.
- Simulation uses recorded runs only; it cannot say what the profile would do to traffic that was never recorded.
