# Data labels and destinations

You don't need any of this for simple workflows. Nothing here is on by
default: a workflow with no guard profile, or with the built-in default
profile, runs, checks and stores exactly as before.

## Data labels

Data labels answer two questions about each step of a run: **where did this
data come from**, and **what does it contain**. Turn them on when you want
checks to know that text fetched from the web is still outside content after
it was copied into a prompt, or when you want to see on a run which steps
handled email addresses or card numbers.

### Turning it on

In **Security → Profiles & bindings**, open a guard profile you can edit and
switch on **Track where data came from**. The profile document gets
`"labels": "propagated"`; switching it off removes the field again, so a
profile that never used it keeps its hash.

Labels are tracked for a run when any profile in the run's guard stack (the
enforced profile, the project or workflow binding, a Guard node's own
profile, or a Guard node's profile override) has the switch on. Runs that
don't track labels store none, scan nothing and read no stored labels; the
only cost is one cached check per run of whether any profile uses the switch.

### What a label holds

| Part | Values | Meaning |
|---|---|---|
| Provenance | `trusted`, `user`, `untrusted_external`, `sensitive` | Where the content came from: your own scheduler, a user or an authenticated caller, or outside (a webhook, the web, a tool). |
| Data classes | `email`, `card_number`, `iban`, your dictionary classes… | What the content contains, found by the same patterns and dictionaries the guard uses. |

On the run view each node shows them in plain words, for example
**from outside · contains email**. The other origins read **from a user**,
**from your system** and **sensitive**.

### Where provenance comes from

- **The run's input.** The server decides, never the caller: the scheduler's
  own runs are `trusted`; runs a signed-in user or an API key started, editor
  runs and pinned data are `user`; chat, forms and app messages are `user`;
  everything else (webhooks, other triggers) is `untrusted_external`. These
  are the same rules production capture uses.
- **Nodes that fetch.** HTTP Request, Web Browse, MCP tools, connectors and
  RAG add `untrusted_external` to what they output. Pinned data on such a
  node is labelled both `user` and `untrusted_external`.
- **Replays.** A replay, a release-gate case, a policy simulation, an MCP
  replay and an eval of a recorded case take the input origin of the run they
  replay (its input step's labels, else its trigger), never the origin of the
  person who started the replay. Golden runs saved from editor runs count as
  `user`.
- **Resumed runs.** A run that paused before it tracked labels does not know
  where its input came from: when it resumes with tracking on, its input and
  every step that already ran count as `untrusted_external`.

### How labels flow through a workflow

A node's labels are its own source, plus the labels of every direct parent
that ran, plus the labels of every node it reads in a template or
expression. A node with no parent reads the run's input directly, so it
carries the input's labels.

- <span v-pre>`{{ results.fetch.body }}`</span> reads the node with id `fetch` only.
  Literal references in a longer expression (`results.fetch`,
  `results["fetch"]`) are read the same way. Any access the parser
  cannot pin to one node (`results[name]`, `$node(variable)`, the whole
  `$json` or `$input`, `arguments`, `this` or a template string with
  <span v-pre>`${ }`</span>) counts as reading every node that ran.
- Settings that name a field or path (an input key, a chart's data path, a
  Guard node's input field) are reads too.
- **Code nodes** count as reading everything they could see.
- **IF, Switch and Merge** take only the parents that actually ran.
- **Loops** label each pass on its own; the loop's output carries the union
  of all passes.
- **Sub-workflows**: the child's trigger starts with the labels of the
  Execute Workflow node's input, and the Execute Workflow node's output takes
  the labels of the child's final output.
- **Approvals**: a paused run keeps its labels, and a person's decision adds
  `user`.
- **Agents** collect the labels of everything in the model's context: the
  prompt, memory, and each tool result, including the data classes found in
  each result. A supervisor's worker starts with the supervisor's labels, and
  the worker's result labels join the supervisor's.

Provenance is never removed. Data classes are removed only when a guard
redacts, masks or protects them in the content, and only from that content:
redacting an email in an agent's prompt does not clear it from a system
prompt or memory that still holds one.

### Checks with labels

Without the switch, guard checks keep their fixed labels: a prompt is `user`
input and a tool result is `untrusted_external`. With it, checks add the
propagated labels to the fixed ones, so a prompt built from a web page is
checked as outside content (the indirect-injection detector runs on it). A
check never sees fewer labels than with the switch off. An explicit **Trust
labels** setting on a Guard node always wins.

### Where labels are stored

- **Run history**: each node's labels, only when they are not empty.
- **Recordings**: each node of the recorded facts keeps the labels from the
  live run (`source: "propagated"`), merged with what a production capture's
  masking pass found, and a recording's memory seed keeps the labels its
  memory had. Imported golden-set files are still never trusted.
- **Session memory, the session tool cache and session artifacts** keep
  labels written while a run tracked them, so a later run that reads them
  picks them up. Memory and artifacts written before (or without) tracking
  have no origin recorded and add nothing. A cached tool result always counts
  as `untrusted_external`, whatever its row holds.

On Postgres, these labels are stored by the same migration; everything else
above works the same on both databases.
