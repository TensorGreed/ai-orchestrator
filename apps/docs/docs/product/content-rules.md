---
description: "Where content rules run in workflows: the Content Rules node, the agent rules port, automatic project and workflow rule sets, the protection port, and verdicts."
---

# Content rules in workflows

The [content rules engine](./content-rules-engine.md) checks content against a rule set. This page covers where it runs in L2M: the **Content Rules** node, the agent's rules port, automatic rule sets for projects and workflows, the **protection** port, and where the verdicts show up afterwards.

## Where content rules run

| Placement | What it checks | What a finding does |
|---|---|---|
| **Content Rules node** on a DAG edge | One field of the incoming item, on the channel you choose | Routes the item to `pass`, `blocked` or `review` instead of failing the run |
| **Rules port** on an Agent or Supervisor | The agent loop: the prompt, every tool call's arguments, every tool result, the final answer | Blocks, rewrites or pauses at that point of the loop |
| **Automatic rule set** bound to a project or workflow | The same agent loop, for every agent without a rules port | Same as the rules port |
| **Model boundary** on LLM Call nodes, chat model nodes, the chains, agents and Supervisors | Each part of a prompt that comes from outside content (retrieved documents, connector, HTTP and web page data, webhook payloads from callers the run does not trust), before the model call | Fails the node, or withholds that part; see [Outside content at the model boundary](#outside-content-at-the-model-boundary) |

An enforced project rule set (see [Bindings](#bindings)) runs in every placement, before anything else.

### Content Rules node

Add **Content Rules** from the AI section of the node drawer and connect it like any other step.

- **Rule set**: a stored rule set, or **Effective rule set** to use whatever the workflow and project bindings resolve to.
- **Channel**: `prompt`, `model_output`, `tool_arguments`, `tool_result` or `final_output`. The channel decides which part of the rule set applies.
- **Input field**: the field of the incoming item to check (default `user_prompt`). An empty field checks the whole item.
- **Trust labels**: provenance labels for the content. When none are set, a `tool_result` check is labelled `untrusted_external` and a `prompt` check `user`. When a rule set tracks where data came from, the labels the run propagated are added to these defaults (see [Data labels and destinations](/product/data-labels-and-destinations)); labels set here always win.
- **Rule set override**: optional JSON merged over the chosen rule set for this node only.

The node has three outputs:

- **pass** carries the item with the checked field replaced by the rewritten content (redacted, masked, protected or stripped). Copies of the unchecked value from the parent node are dropped, so the original does not travel on next to the rewritten one.
- **blocked** carries only the verdict summary.
- **review** carries only the verdict summary. When nothing is connected to `review`, the item goes to `blocked`.

When a rule asks for approval (`require_approval`), the run pauses the same way a Human Approval node does. The request appears in the [approvals inbox](./approvals.md) with the message from the node and masked evidence. Approving sends the rewritten item to `pass`; rejecting sends the summary to `blocked`. Nobody deciding within the node's `timeoutMinutes` (default 1440, one day; it was 60 before approval timeouts were enforced) counts as a rejection; see [Timeouts](./approvals.md#timeouts).

### Rules port on agents

Attach a Content Rules node to an agent's rules port (port id `guard`; 0 or 1; the slot sits up and to the left of the agent on the canvas). The port's rule set then runs at four points of the agent loop:

| Hook | Channel | Labels | Block | Rewrite | Review or approval |
|---|---|---|---|---|---|
| Before the first model call, and on each new user reply | `prompt` | `user` | The node fails with "Content rules blocked …" | The message is replaced before the model sees it | The run pauses for approval |
| Before each tool call | `tool_arguments` | none | The call is not made; the model gets a tool error telling it not to retry the same arguments | The call uses the rewritten arguments | The run pauses for approval |
| After each tool result, before the model sees it | `tool_result` | `untrusted_external` | The result is withheld; the model is told to continue without it | The model sees the rewritten result | The run pauses for approval |
| Before the final answer leaves the node | `final_output` | none | The node fails with "Content rules blocked …" | The rewritten answer is the node's output | The run pauses for approval |

Internal tools (the session cache and clarification tools) only replay content that was already checked, so they are not checked again. When an agent pauses for approval and the approver accepts, the node runs again with that approval granted; a rejection fails the node. An approval is tied to the node, the channel, the tool and the masked findings, so a re-run that calls another tool or brings other values (another address, another card) asks again. It covers that one re-run of the node only. Approvals live in the paused run's state, which only the approval decision writes; run input, webhook bodies and variables cannot carry one (keys starting with `__` are dropped from them).

A tool call that fails is checked too: its error text comes from the tool, so it is checked on the `tool_result` channel with the `untrusted_external` label and spotlit like a result. If the rules rewrite tool arguments into something that is not an object, the call is refused rather than sent with the original arguments. The session cache keeps the rewritten arguments.

A Content Rules node attached to a port does not run as a workflow step and cannot have DAG edges of its own; the validator reports `guard_port_on_dag` if it does. Its channel and input field are ignored.

**Workers.** A Supervisor's workers are agents too. Each worker runs with its own rules port or, without one, the automatic rule sets. A worker's answer is a tool result for the Supervisor, so the Supervisor's own `tool_result` check sees it. When a worker pauses for approval, the Supervisor pauses with it.

**Spotlighting and canaries.** A rule set with `spotlighting` (`delimiters` or `datamark`) wraps every tool result before the model sees it, and the parts of an agent's prompt that come from outside content (template values read from untrusted steps, or a server prompt) and memory holding outside content, and adds the matching instructions to the start of the system prompt (with `hardenSystemPrompt`, also the prompt-hardening paragraph). Only the model call gets the marked text: memory keeps the prompt and the conversation as written, so marks never pile up across turns. A rule set with `canaries: { enabled: true }` plants a random canary line in the system prompt and checks tool arguments and the final answer for it.

### Automatic rule sets

Agents without a rules port use the rule sets their project and workflow resolve to. Unbound projects use the built-in **Default rule set** unless `GUARD_AUTO_APPLY=false`, in which case only explicit bindings and rules ports apply.

The Trace tab names the source of each agent's rule sets: rules port, enforced by project, workflow binding, project binding or instance default.

### Outside content at the model boundary

Before a model call, every part of the system and user prompt that came from outside content is checked on the `tool_result` channel with the `untrusted_external` label. The parts are found from the prompt's template values and the provenance labels the run already computes, so the template's own text is never checked, and the question a signed-in person typed is not outside content. Values that an earlier **Prompt Template** rendered, or the numbered `context` of a **RAG Retrieve** or **Rerank** node, are split again into their parts, so each retrieved document is checked on its own. The same text is checked once per run. Rule events from this check have the placement `retrieval`.

| Where | Rule sets | What a finding does |
|---|---|---|
| LLM Call, chat model nodes and the chains (Basic LLM Chain, Q&A, Summarization, Information Extractor, Text Classifier, Sentiment Analysis, AI Transform) | The run's rule sets | A block fails the node; a rewrite changes that part of the prompt; a review or approval pauses the run and re-runs the node once approved. Under the built-in **Default rule set** applied automatically, the check only records what it would have done (shadow) for now. |
| Agents and Supervisors | The rules port, or the run's rule sets | Same, enforced. Under the built-in rule set applied automatically, parts that came straight from the run's input are only recorded, since the agent's own prompt check already acts on them; parts from retrieval and other steps are enforced. |

Two optional settings on a rule set change this:

```json
{ "retrieval": { "onBlock": "withhold", "perDocument": true } }
```

- `onBlock: "withhold"` replaces a blocked part with `[content withheld by content rules]` and lets the model call go ahead. When several rule sets apply, an explicit `onBlock: "fail"` in any of them wins.
- `perDocument: true` makes RAG Retrieve and Rerank check each document as it is retrieved. A blocked document, or one that would need a review, is dropped; rewrites apply to the document text. The `context` is rebuilt and numbered from what is left, and the node output gains `contentRules: { dropped, redacted }`. When every document is dropped, the node returns an empty context. The model boundary then reuses these checks for the documents that reach the prompt unchanged.

Nothing here runs without content rules: with `GUARD_AUTO_APPLY=false` and no bindings, or when no rule set has a `tool_result` channel, prompts reach the model as before.

## Rule sets

Rule sets live on the **Security** page, under **Rule sets & bindings**. Admins and builders can create, edit, duplicate, import and delete them; operators and viewers can read and export them. A rule set that any project enforces can only be edited or re-imported by an admin (others get `403`), so a builder cannot loosen the floor by changing the rule set itself.

- **Versions.** Every save is a new immutable version with its hash, author, time and an optional note. Saving a document whose hash has not changed does not add a version. Runs record the rule set id, version and hash they used.
- **Diff.** Pick two versions to see every changed setting by path.
- **Export and import.** Export downloads a version as JSON (headers `x-guard-profile-version` and `x-guard-profile-hash`); import accepts the same JSON as a new rule set or as a new version of an existing one. The built-in rule set's documents, versions and exports carry its display name, Default rule set; its hash header still names the stored version runs pin.
- **Validation.** Errors come back per field (`channels.prompt.detectors.0.threshold: …`) and are shown next to the editor. Rule sets may not hold key material: provider options name a stored secret (`keyId`), and the fallback cannot be `protect`. Custom dictionary patterns are limited to 256 characters, and patterns with nested quantifiers such as `(a+)+` are refused (and skipped if an older rule set already holds one).
- **Built-in default.** The shipped default rule set is seeded read-only. Duplicate it to change it. When an upgrade ships a changed default, a new version is added.
- **Deleting** a rule set is refused while a project or workflow is bound to it.
- **Simulate.** **Simulate on recent traffic**, next to Save, replays recent recorded runs with the editor's changes before you save them. See [Rule set simulation](./content-rules-simulation.md).

Git sync is not part of this release. Export and import JSON to keep rule sets in a repository.

The editor sets, per channel, which detectors run and their thresholds, the action for each category or data class, and the action for anything else; and for the whole rule set, shadow mode per action, the latency budget and its fail-open or fail-closed choice, the protection fallback, spotlighting and canaries. **Edit as JSON** covers everything else, including dictionaries and detector options.

## Bindings

A project and each of its workflows can bind a rule set:

| Mode | Project | Workflow |
|---|---|---|
| `inherit` | use the instance default | use the project's binding |
| `override` | use this rule set | use this rule set instead of the project's |
| `enforced` | admins only: this rule set always runs first, everywhere in the project | not available |

Precedence, for each agent:

1. An **enforced** project rule set runs first. Builders cannot change or remove the binding, or edit the rule set it points at; the editor shows a lock.
2. Then the agent's **rules port** rule set if it has one, otherwise the **workflow override**, otherwise the **project override**, otherwise the **instance default** (when `GUARD_AUTO_APPLY` is on).

The applied rule sets are deduplicated by hash. All of them run, and the most severe action wins, so an override can add checks to an enforced rule set but never loosen it. A Content Rules node with **Effective rule set** resolves the same way; one with a named rule set runs the enforced rule set first and then its own.

An enforced project rule set covers the project's runs. It reaches calls through the [MCP gateway](./mcp-gateway.md#content-rules-on-the-gateway) only once the toolset or the client calling it has a rule set of its own; until then, gateway calls to the project's toolsets are not checked by content rules.

Changing a project binding needs write access to that project, and reading it (or `GET /api/guard/effective?projectId=`) needs read access, so a project membership with fewer rights than the global role applies here too.

`GET /api/guard/effective?workflowId=` returns the applied rule sets and the chain of levels they came from. The Content Rules node's config panel and the bindings panel show it too.

## Protection port

Attach **Protection Provider** nodes to a Content Rules node's **protection** port (0..N; the slot hangs below the node). Each provider covers a list of data classes (or `*`) with one of:

| Provider | Reversible | Key |
|---|---|---|
| `mask` | no | none |
| `keyed_hash` | no | required |
| `aes_gcm` | yes | required |
| `token_vault` | yes | only for deterministic tokens |
| `surrogate` | no (one-way) | none: the deployment's own key |

**Surrogate** swaps each value for a realistic stand-in of the same shape (an email stays an email, a card number stays a valid-looking card number), keyed by the deployment, so the same value always gets the same stand-in. It is one-way: asking to reveal a surrogate answers 400 "Surrogates are one-way; use the token vault if you need the original back". See [Data labels and destinations](./data-labels-and-destinations.md#surrogates-at-run-time).

Keys are stored secrets chosen by reference (`keySecretRef.secretId`); the workflow never holds a key, and the key is read from `SecretService` only when a value is protected. The token vault keeps values in the `guard_token_vault` table, sealed with AES-256-GCM under the instance master key and bound to its purpose, so tokens still resolve after a restart and a database dump does not reveal them.

With **protectMatches** (on by default), rules that would allow, mask or redact one of the provider's classes become `protect`. Rules that block, review or ask for approval are never loosened, and injection findings are never protected.

If a finding should be protected but no provider covers its class, the key is missing or the provider fails, the rule set's `protection.fallback` applies. It defaults to `block`.

## What gets recorded

Every check writes rows to `guard_events`: one per applied action, or one row for a clean verdict. A row holds:

- the run, workflow, project and node, the placement (`node`, `agent`, `retrieval` for the [model boundary](#outside-content-at-the-model-boundary), or `gateway` for an [MCP gateway call](./mcp-gateway.md#content-rules-on-the-gateway)), the agent step and the tool name;
- the channel, detector, category, data class and score;
- the requested action, the action that applied, the verdict's overall action, and whether the rule was in shadow mode;
- masked evidence (for example `j•••@e••••••.com`) and the detector's message;
- the rule set id, version and hash, the verdict's latency, whether the budget ran out and which detectors it skipped.

Rows never hold the content that was checked, the raw matched value, protection tokens or keys. Evidence is masked inside the engine before it reaches the workflow engine, so nothing raw is available to write. Pattern detectors (egress, exfiltration, SQL, command and path) keep a short excerpt: URL query strings and fragments are dropped (scheme, host and path stay), SQL string literals are blanked, and anything the data rule patterns recognise in the excerpt or in a parser error is masked. Events follow `EXECUTION_HISTORY_RETENTION_DAYS` and are deleted with their workflow.

## Where verdicts show up

- **Trace.** On the Runs page, an expanded run shows a **Content rules** panel: per Content Rules node and per agent step, the channel, tool, action, a shadow badge when shadow rules would have done more, masked evidence, the slowest detectors and the rule sets with their versions and source.
- **Run tape.** Steps where the rules blocked, held for review, waited for approval or rewrote content carry a marker.
- **Security page.** Verdict totals, verdicts per day by outcome, counts by action, category and channel, the detectors that fire most, what shadow rules would have blocked, and the latest events with links to their runs. Filter by project, workflow, rule set, source (workflow runs or MCP gateway calls) and window.
- **Canvas.** Content Rules cards show their `pass`, `blocked` and `review` outputs and an empty protection slot; agents show a rules slot. The canvas key lists the rules and protection port colours.

## Limits and deployment notes

- Agents check the `prompt`, `tool_arguments`, `tool_result` and `final_output` channels. Intermediate model turns (`model_output`) are not checked inside the loop; use a Content Rules node after the agent to check its output on that channel.
- **Egress is advisory for MCP tools.** The egress detector scans tool arguments for `scheme://` URLs only and resolves their hostnames with the system resolver at check time. The MCP server resolves the name again when it makes the request, so a host that resolves differently a moment later (DNS rebinding) is not caught, and a host written without a scheme is not checked. Enforce egress where the request is made: a network policy, proxy or sandbox around the MCP server.
- HTTP Request and SQL connector nodes are not checked automatically, and HTTP Request has no egress detector. Put a Content Rules node with the `tool_arguments` channel in front of them.
- **A Content Rules node is not a data barrier.** It decides which branch runs and what it passes on, but later nodes can still read earlier results directly with <span v-pre>`{{results.<nodeId>.field}}`</span>. Do not template the output of a node before the check into anything the rules are meant to protect.
- **Approvals use the rule set from the pause.** A Content Rules node waiting for approval stored the item it would send to `pass`; approving later sends that item even if the rule set changed while the run was paused. Reject and re-run when a rule set change matters.
- **Sub-workflows** run under the calling workflow's rule set resolution, not their own bindings. **Error-handler workflows** run under their own workflow and project bindings.
- **Read scoping.** Rule events, the Security page counts and the bindings listed on a rule set are limited to the workflows and projects the user can read. Rule sets and their versions are instance-wide: every signed-in user can read every rule set. Run history itself is filtered by role only.
- **Custom patterns.** The nested-quantifier check catches the common catastrophic shapes but not every slow pattern (overlapping alternations such as `(a|aa)+` pass). Patterns run over the whole checked text and the latency budget cannot interrupt a regular expression that is already running, so keep dictionary patterns simple and anchored.
- **Token vault.** `guard_token_vault` rows are not covered by run retention and are not scoped to a project: a token resolves for any run on the instance, and rows stay until they are deleted. Sealing binds each value to the vault's purpose but not to its token or row. Keys for deterministic tokens and keyed hashes must be at least 16 bytes.
