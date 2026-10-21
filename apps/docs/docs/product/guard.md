# Guard in workflows

The [guard engine](./guard-engine.md) checks content against a profile. This page covers where it runs in L2M: the **Guard** node, the agent **guard** port, automatic profiles for projects and workflows, the **protection** port, and where the verdicts show up afterwards.

## Where the guard runs

| Placement | What it checks | What a finding does |
|---|---|---|
| **Guard node** on a DAG edge | One field of the incoming item, on the channel you choose | Routes the item to `pass`, `blocked` or `review` instead of failing the run |
| **Guard port** on an Agent or Supervisor | The agent loop: the prompt, every tool call's arguments, every tool result, the final answer | Blocks, rewrites or pauses at that point of the loop |
| **Automatic profile** bound to a project or workflow | The same agent loop, for every agent without a guard port | Same as the guard port |

An enforced project profile (see [Bindings](#bindings)) runs in every placement, before anything else.

### Guard node

Add **Guard** from the AI section of the node drawer and connect it like any other step.

- **Profile**: a stored profile, or **Effective profile** to use whatever the workflow and project bindings resolve to.
- **Channel**: `prompt`, `model_output`, `tool_arguments`, `tool_result` or `final_output`. The channel decides which part of the profile applies.
- **Input field**: the field of the incoming item to check (default `user_prompt`). An empty field checks the whole item.
- **Trust labels**: provenance labels for the content. When none are set, a `tool_result` check is labelled `untrusted_external` and a `prompt` check `user`.
- **Profile override**: optional JSON merged over the chosen profile for this node only.

The node has three outputs:

- **pass** carries the item with the checked field replaced by the rewritten content (redacted, masked, protected or stripped). Copies of the unguarded value from the parent node are dropped, so the original does not travel on next to the rewritten one.
- **blocked** carries only the verdict summary.
- **review** carries only the verdict summary. When nothing is connected to `review`, the item goes to `blocked`.

When a rule asks for approval (`require_approval`), the run pauses the same way a Human Approval node does. The request appears under Approvals with the message from the node and masked evidence. Approving sends the rewritten item to `pass`; rejecting sends the summary to `blocked`.

### Guard port on agents

Attach a Guard node to an agent's **guard** port (0 or 1; the slot sits up and to the left of the agent on the canvas). The port's profile then runs at four points of the agent loop:

| Hook | Channel | Labels | Block | Rewrite | Review or approval |
|---|---|---|---|---|---|
| Before the first model call, and on each new user reply | `prompt` | `user` | The node fails with "Guard blocked …" | The message is replaced before the model sees it | The run pauses for approval |
| Before each tool call | `tool_arguments` | none | The call is not made; the model gets a tool error telling it not to retry the same arguments | The call uses the rewritten arguments | The run pauses for approval |
| After each tool result, before the model sees it | `tool_result` | `untrusted_external` | The result is withheld; the model is told to continue without it | The model sees the rewritten result | The run pauses for approval |
| Before the final answer leaves the node | `final_output` | none | The node fails with "Guard blocked …" | The rewritten answer is the node's output | The run pauses for approval |

Internal tools (the session cache and clarification tools) only replay content that was already checked, so they are not checked again. When an agent pauses for approval and the approver accepts, the node runs again and that exact finding is accepted for the rest of the run; a rejection fails the node.

A Guard node attached to a port does not run as a workflow step and cannot have DAG edges of its own; the validator reports `guard_port_on_dag` if it does. Its channel and input field are ignored.

**Workers.** A Supervisor's workers are agents too. Each worker runs with its own guard port or, without one, the automatic profiles. A worker's answer is a tool result for the Supervisor, so the Supervisor's own `tool_result` check sees it. When a worker pauses for approval, the Supervisor pauses with it.

**Spotlighting and canaries.** A profile with `spotlighting` (`delimiters` or `datamark`) wraps every tool result before the model sees it and adds the matching instructions to the start of the system prompt (with `hardenSystemPrompt`, also the prompt-hardening paragraph). A profile with `canaries: { enabled: true }` plants a random canary line in the system prompt and checks tool arguments and the final answer for it.

### Automatic profiles

Agents without a guard port use the profiles their project and workflow resolve to. Unbound projects use the built-in **Default guard profile** unless `GUARD_AUTO_APPLY=false`, in which case only explicit bindings and guard ports apply.

The Trace tab names the source of each agent's profiles: guard port, enforced by project, workflow binding, project binding or instance default.

## Profiles

Profiles live on the **Security** page, under **Profiles & bindings**. Admins and builders can create, edit, duplicate, import and delete them; operators and viewers can read and export them.

- **Versions.** Every save is a new immutable version with its hash, author, time and an optional note. Saving a document whose hash has not changed does not add a version. Runs record the profile id, version and hash they used.
- **Diff.** Pick two versions to see every changed setting by path.
- **Export and import.** Export downloads a version as JSON (headers `x-guard-profile-version` and `x-guard-profile-hash`); import accepts the same JSON as a new profile or as a new version of an existing one.
- **Validation.** Errors come back per field (`channels.prompt.detectors.0.threshold: …`) and are shown next to the editor. Profiles may not hold key material: provider options name a stored secret (`keyId`), and the fallback cannot be `protect`.
- **Built-in default.** The shipped default profile is seeded read-only. Duplicate it to change it. When an upgrade ships a changed default, a new version is added.
- **Deleting** a profile is refused while a project or workflow is bound to it.

Git sync is not part of this release. Export and import JSON to keep profiles in a repository.

The editor sets, per channel, which detectors run and their thresholds, the action for each category or data class, and the action for anything else; and for the whole profile, shadow mode per action, the latency budget and its fail-open or fail-closed choice, the protection fallback, spotlighting and canaries. **Edit as JSON** covers everything else, including dictionaries and detector options.

## Bindings

A project and each of its workflows can bind a profile:

| Mode | Project | Workflow |
|---|---|---|
| `inherit` | use the instance default | use the project's binding |
| `override` | use this profile | use this profile instead of the project's |
| `enforced` | admins only: this profile always runs first, everywhere in the project | not available |

Precedence, for each agent:

1. An **enforced** project profile runs first. Builders cannot change or remove it; the editor shows a lock.
2. Then the agent's **guard port** profile if it has one, otherwise the **workflow override**, otherwise the **project override**, otherwise the **instance default** (when `GUARD_AUTO_APPLY` is on).

Profiles in the stack are deduplicated by hash. All of them run, and the most severe action wins, so an override can add checks to an enforced profile but never loosen it. A guard node with **Effective profile** resolves the same way; a guard node with a named profile runs the enforced profile first and then its own.

`GET /api/guard/effective?workflowId=` returns the stack and the chain of levels it came from. The guard node's config panel and the bindings panel show it too.

## Protection port

Attach **Protection Provider** nodes to a Guard node's **protection** port (0..N; the slot hangs below the guard). Each provider covers a list of data classes (or `*`) with one of:

| Provider | Reversible | Key |
|---|---|---|
| `mask` | no | none |
| `keyed_hash` | no | required |
| `aes_gcm` | yes | required |
| `token_vault` | yes | only for deterministic tokens |

Keys are stored secrets chosen by reference (`keySecretRef.secretId`); the workflow never holds a key, and the key is read from `SecretService` only when a value is protected. The token vault keeps values in the `guard_token_vault` table, sealed with AES-256-GCM under the instance master key and bound to its purpose, so tokens still resolve after a restart and a database dump does not reveal them.

With **protectMatches** (on by default), rules that would allow, mask or redact one of the provider's classes become `protect`. Rules that block, review or ask for approval are never loosened, and injection findings are never protected.

If a finding should be protected but no provider covers its class, the key is missing or the provider fails, the profile's `protection.fallback` applies. It defaults to `block`.

## What gets recorded

Every check writes rows to `guard_events`: one per applied action, or one row for a clean verdict. A row holds:

- the run, workflow, project and node, the placement (`node` or `agent`), the agent step and the tool name;
- the channel, detector, category, data class and score;
- the requested action, the action that applied, the verdict's overall action, and whether the rule was in shadow mode;
- masked evidence (for example `j•••@e••••••.com`) and the detector's message;
- the profile id, version and hash, the verdict's latency, whether the budget ran out and which detectors it skipped.

Rows never hold the content that was checked, the raw matched value, protection tokens or keys. Evidence is masked inside the engine before it reaches the workflow engine, so nothing raw is available to write. Events follow `EXECUTION_HISTORY_RETENTION_DAYS` and are deleted with their workflow.

## Where verdicts show up

- **Trace.** On the Runs page, an expanded run shows a **Guard** panel: per guard node and per agent step, the channel, tool, action, a shadow badge when shadow rules would have done more, masked evidence, the slowest detectors and the profiles with their versions and source.
- **Run tape.** Steps where a guard blocked, held for review, waited for approval or rewrote content carry a marker.
- **Security page.** Verdict totals, verdicts per day by outcome, counts by action, category and channel, the detectors that fire most, what shadow rules would have blocked, and the latest events with links to their runs. Filter by project, workflow, profile and window.
- **Canvas.** Guard cards show their `pass`, `blocked` and `review` outputs and an empty protection slot; agents show a guard slot. The canvas key lists the guard and protection port colours.

## Limits

- Agents check the `prompt`, `tool_arguments`, `tool_result` and `final_output` channels. Intermediate model turns (`model_output`) are not checked inside the loop; use a guard node after the agent to check its output on that channel.
- The egress guard resolves hostnames with the system resolver at check time. A host that resolves differently a moment later (DNS rebinding) is not caught.
- HTTP Request and SQL connector nodes are not checked automatically. Put a guard node with the `tool_arguments` channel in front of them.
- The events listing is filtered by role only, like run history: anyone who can read runs can read every project's guard events.
