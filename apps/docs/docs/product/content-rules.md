---
title: "Content rules in workflows: nodes, ports and verdicts"
description: "Where content rules run in workflows: the Content Rules node, the agent rules port, automatic project and workflow rule sets, protection port, verdicts."
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
| **Response** to an external caller | What a webhook, chat or MCP invoke caller receives, once at the end of the run | Rewrites or withholds the response; see [Responses to external callers](#responses-to-external-callers) |
| **Request** at the webhook route | The incoming webhook payload, before the run starts (optional `trigger_input` channel) | Refuses the request, or rewrites what the run receives |
| **Reveal node** | Protection tokens in one field, against the reveal rules of the run's rule sets | Restores the values a rule allows; see [Reveal node](#reveal-node) |
| **Gateways** | Calls through the [MCP gateway](./mcp-gateway.md#content-rules-on-the-gateway) and the [/v1 AI gateway](./ai-gateway.md#content-rules) | Blocks or rewrites the call or the answer |

An enforced project rule set (see [Bindings](#bindings)) runs in every placement, before anything else.

Each rule event records its placement: `node`, `agent`, `retrieval` (the model boundary), `response`, `request`, `reveal` or `gateway`. The Security page and `GET /api/guard/events?placement=` can filter on `gateway`, `response` and `request`, or on everything but gateway calls (`run`).

To check what an answer says rather than the data in it (an answer schema, topics, content safety, grounding in retrieved documents), add [output checks](./content-rules-output-checks.md) to a rule set.

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
| Agents and Supervisors | The rules port, or the run's rule sets | Same, enforced. Under the built-in rule set applied automatically, the caller's own words are only recorded, since the agent's own prompt check already acts on them; everything else is enforced (see below). |

Shadow applies when the run uses the instance's automatic rule set (the Trace tab shows "instance default"), not when someone bound the built-in rule set to the workflow or project. Shadow checks record only what they found: a clean part writes no rule event. The shadow period ends in a later release, announced one release ahead.

**The caller's own words.** At an agent under the automatic built-in rule set, a part counts as the caller's own words when the run was started by a webhook, an API call, a chat, a form or an MCP server call, and the part comes from the run's input either directly or only through steps that reshape it (Set, Edit Fields, Rename Keys, Merge, Code, Prompt Template, If, Switch, Filter, Loop, Sort, Limit, Aggregate, Split Out, Remove Duplicates, Date & Time, Input Validator, Try/Catch). Any other step in the chain (retrieval, a connector, an HTTP request, a model, an agent, a sub-workflow) makes the part outside content. Runs started by email, feeds, files, chat apps, queues, schedules or another workflow carry third-party content, so their input is outside content too.

**Not covered yet.** The retry calls of the Output Parser and Output Guardrail nodes, and earlier turns an agent replays from Simple Memory, reach the model with destination rules only. Tool results stored in memory were checked when they arrived.

Two optional settings on a rule set change this:

```json
{ "retrieval": { "onBlock": "withhold", "perDocument": true } }
```

- `onBlock: "withhold"` replaces a blocked part with `[content withheld by content rules]` and lets the model call go ahead. When several rule sets apply, an explicit `onBlock: "fail"` in any of them wins.
- `perDocument: true` makes RAG Retrieve and Rerank check each document as it is retrieved. A blocked document, or one that would need a review, is dropped; rewrites apply to the document text. The `context` is rebuilt and numbered from what is left, and the node output gains `contentRules: { dropped, redacted }`. When every document is dropped, the node returns an empty context. If the rule sets cannot be loaded, the node skips these checks and returns its documents; the model boundary downstream then fails the model call. The model boundary reuses these checks for the documents that reach the prompt unchanged.

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

An enforced project rule set covers the project's runs. It also checks calls through the [MCP gateway](./mcp-gateway.md#content-rules-on-the-gateway) to the project's toolsets and through the [/v1 AI gateway](./ai-gateway.md#content-rules) to the project's route sets, with no rule set bound to the toolset, route set or client. Before this release it reached gateway calls only once the toolset or the client had a rule set; `GATEWAY_RULES_WITHOUT_BINDING=false` keeps that behaviour.

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

## Reveal node

A **Reveal** node turns protection tokens in one field of the incoming item back into the original values. It is a normal DAG step: put it right before the step that truly needs the value (a CRM write, a reply to the customer), not earlier.

Nobody may reveal unless a rule set that applies to the run says so. A rule set's `reveal` block lists who may reveal which data classes:

```json
"reveal": {
  "rules": [
    { "name": "Billing admins", "dataClasses": ["card_number"], "subjects": { "roles": ["admin"] }, "requireApproval": true },
    { "dataClasses": ["email"], "subjects": { "serviceAccounts": ["sa-crm"] }, "workflows": ["wf-crm-sync"] }
  ]
}
```

- **Only an admin can save a rule set with reveal rules.** A builder's save of one answers 403, and a node's inline override can never add or remove them.
- **Which rule sets count.** Only rule sets that apply to the run: the project's enforced rule set, the workflow and project bindings, the deployment's rule sets and, for a gateway-triggered run, the toolset's and client's. Choosing a rule set on the node only narrows that choice; a rule set that is not bound to the run contributes nothing, so its tokens stay protected. When the project's enforced rule set has a `reveal` block, it is the only source of reveal rules in that project (an empty `rules` list turns reveal off there).
- **Who matches.** Roles and users match only runs a signed-in person started. Webhook, chat, schedule and form runs act as the workflow's owner and gateway runs as the MCP client, so a role or user rule never matches them, whoever the owner is. A service account matches only a rule that names its id under `serviceAccounts`, whatever its role, and only for runs it started with its key (a webhook or schedule run of a workflow it created is not its run). Saving a rule set refuses a service account listed under `users` and a person listed under `serviceAccounts`. `workflows` limits a rule to those workflows.
- **Which tokens.** Token vault tokens (`tok_<class>_…`), found by shape; format-preserving vault tokens for the classes the node lists, found by the data detectors and then looked up exactly in the vault; and encrypted values (`enc:<key>:…`) under the keys the node lists. A vault token issued in another project is never revealed; tokens issued before tokens were scoped to a project are revealed only for a run a signed-in admin started. Tokens a gateway toolset or route set without a project issues are scoped to that toolset or route set, so no workflow run reveals them. Mask, keyed hash and surrogate are one-way and never reveal.
- **Encrypted values follow their key.** An `enc:` value opens under the key secret that sealed it, for its data class. Sharing that key secret with another project shares the ability to reveal its values there (still only as that project's reveal rules allow).
- **What the node does with the rest.** A token no rule allows stays as it is. With **When a token may not be revealed: Fail the step** one refused token fails the node and nothing is revealed.
- **Approval.** A matching rule with `requireApproval` pauses the run until an admin approves; the person who started the run cannot approve their own reveal, and a rejection needs a reason. The approver sees data classes and counts, never values. Approving runs the node again for exactly those tokens, and the audit entry names the approver.
- **Where revealed data may go.** Revealed values carry the `sensitive` label and their data class again, so [destination rules](./data-labels-and-destinations.md) and outbound checks decide where they can be sent next.
- **Revealed values are not kept.** Steps after the Reveal node in the same run get the values. Everything the run keeps or sends outside holds the tokens again: the run history (every step's input and output, errors and activity), the live run view, a paused run's saved state, the error workflow's input, and agent memory, the session tool cache and session artifacts. A value is put back as its token wherever it appears unchanged; a value a step reformatted (cut, re-spaced, re-encoded) is not found, so let destination rules decide where it may go. A run that pauses after a Reveal node continues with the tokens. A run that revealed something is never captured for replay and stores no MCP cassette or model tape. A [`response` channel](#responses-to-external-callers) checks what the caller receives, so it judges the tokens.
- **Sub-workflows.** A sub-workflow in the same project reveals under the run's rule sets. One in another project never reveals, and the tokens its Protect steps issue belong to its own project.
- **Replays never reveal.** In a replay, an eval run or a rule simulation the node passes its input through untouched and records nothing.

Each Reveal step that revealed or refused something writes rule events with placement, channel and action `reveal` (a refused class records `block` as its effective action), with the first 16 hex characters of each token's sha256 as evidence, and one audit log entry `content_rules.reveal` with who started the run, the workflow, the node and the counts. Neither ever holds a value or a token. The audit entry goes to log streaming like every other audit entry; for a run nobody signed in to start, the system is its actor and the run's subject is in its details. If the audit entry or the events cannot be written, nothing is revealed.

Equal values protected in two projects that share a key secret get the same token, which only the issuing project can reveal. Keep a separate key per project; scoping the stored value hash per project is a planned follow-up.

## Responses to external callers

A rule set with a `response` channel checks what external callers receive, with no Content Rules node in the workflow. It applies to runs started from `/webhook/<path>` and `/webhook-test/<path>` (the chat widget included), `/api/chat/<id>` and `/api/mcp-server/<path>/invoke`. Editor runs, schedules, the builder routes and sub-workflow runs are not checked. MCP gateway calls are checked by the gateway's own `tool_result` rules on a toolset or client binding, not by the `response` channel. The built-in rule set has no `response` channel, so nothing changes until you add one: open a rule set, choose the **Response** tab and use **Check responses** to copy the final answer rules.

- **Rewritten.** The caller gets the rewritten output, and the run history and the idempotency store keep that version. Node results keep what ran, for builders.
- **Blocked, review or approval.** The caller cannot wait for a person, so the output is withheld. Webhooks and chat answer `422` with `{ "error": "The response was withheld by content rules.", "code": "content_filter", "executionId": "…" }` (chat adds `session_id`). MCP invoke answers a tool error result. The run itself ends `success`. A check that cannot run withholds the output too.
- **Paused runs.** A run that pauses for approval answers only `{ "waitingForApproval": true, "executionId": "…" }`, without the approval message, because that message can quote any step's data. Approvers still read the message.
- **Failed runs.** Webhook and MCP invoke callers read `The workflow run failed.` and the execution id; chat callers get `status: "error"` with no error text. The error text, which can quote run data, stays in the run history.
- **Webhook Response replies** are checked on the headers and body they send.
- **Run views.** Once any rule set, in any of its versions, has a `response` channel, viewers and operators reading such a run (`GET /api/executions/<id>` and its event stream) see each step's status and timing but not its data. The run's own output is the checked one. Builders and admins see everything. Audit bundle exports and golden run recordings are not masked: they hold the run as it ran.
- **Queued runs** go only to workers that can check responses. While a worker of the pool cannot, these runs execute inline and count in `dispatch_inline_runs_total{reason="capability:content-rules-response-v1"}`. A result returned without the check is withheld.

An optional `trigger_input` channel checks webhook payloads at the route, before anything is reserved or run. A block answers `400` with `{ "error": "The request was refused by content rules.", "code": "content_filter" }`. A rewrite is what the run receives. These checks are recorded with the placement `request`. A refused request never runs, so the Security page shows "request refused, no run" instead of a run link. The check also runs on idempotent retries that are answered from the store. It does not run on `/api/chat` or MCP invoke.

Things to expect when you add a `response` channel:

- Idempotent retries stored before the channel existed are answered unchecked until they expire.
- Golden runs recorded from these triggers before the channel existed show a diff on replay, because replays apply the same check.
- The history output is the checked version for runs that never paused. A run resumed after an approval stores the output it produced, unchecked; nobody external is waiting for it.

## What gets recorded

Every check writes rows to `guard_events`: one per applied action, or one row for a clean verdict. A row holds:

- the run, workflow, project and node, the placement (`node`, `agent`, `retrieval` for the [model boundary](#outside-content-at-the-model-boundary), `response` or `request` for [external callers](#responses-to-external-callers), or `gateway` for an [MCP gateway call](./mcp-gateway.md#content-rules-on-the-gateway)), the agent step and the tool name;
- the channel, detector, category, data class and score;
- the requested action, the action that applied, the verdict's overall action, and whether the rule was in shadow mode;
- masked evidence (for example `j•••@e••••••.com`) and the detector's message;
- the rule set id, version and hash, the verdict's latency, whether the budget ran out and which detectors it skipped.

Rows never hold the content that was checked, the raw matched value, protection tokens or keys. Evidence is masked inside the engine before it reaches the workflow engine, so nothing raw is available to write. Pattern detectors (egress, exfiltration, SQL, command and path) keep a short excerpt: URL query strings and fragments are dropped (scheme, host and path stay), SQL string literals are blanked, and anything the data rule patterns recognise in the excerpt or in a parser error is masked. Events follow `EXECUTION_HISTORY_RETENTION_DAYS` and are deleted with their workflow. A project can keep its rule events longer or shorter than its runs ([per-project retention](../operations/data-retention.md#per-project-retention)), for example a year for an audit; an event that outlives its run shows "Run no longer stored" on the Security page instead of a run link.

## Where verdicts show up

- **Trace.** On the Runs page, an expanded run shows a **Content rules** panel: per Content Rules node and per agent step, the channel, tool, action, a shadow badge when shadow rules would have done more, masked evidence, the slowest detectors and the rule sets with their versions and source.
- **Run tape.** Steps where the rules blocked, held for review, waited for approval or rewrote content carry a marker.
- **Security page.** Verdict totals, verdicts per day by outcome, counts by action, category and channel, the detectors that fire most, what shadow rules would have blocked, and the latest events with links to their runs. Filter by project, workflow, rule set, source (workflow runs, responses to callers, incoming requests or MCP gateway calls) and window.
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
- **Model-backed output checks on responses.** The `response` check offers no model, so an output check set to call one (safety by model, topics by meaning, the grounding judge) cannot run there and follows the rule set's failure policy: with `fail_closed`, the default, every response is withheld. See [Output checks](./content-rules-output-checks.md#limits).
- **Audit bundles and golden runs keep step data.** Anyone who can read the workflow, viewers included, can export a run's audit bundle and read its golden run recordings. Both hold each step's data as it ran, unmasked, even while a `response` rule set masks run views.
- **Run view masking is not per run.** Once any version of any rule set has a `response` channel, viewers and operators see webhook, chat and MCP invoke runs masked, older runs included. Removing the channel in a new version does not unmask them, because earlier versions still have it; deleting those rule sets does.
- **Token vault.** `guard_token_vault` rows are not covered by run retention, and rows stay until they are deleted. Each row records the project and run that issued it (rows from before this was recorded have none); a Reveal node reveals only its own project's tokens, while a Content Rules node reuses a deterministic token for an equal value whichever project issued it. Sealing binds each value to the vault's purpose but not to its token or row. Keys for deterministic tokens and keyed hashes must be at least 16 bytes.
