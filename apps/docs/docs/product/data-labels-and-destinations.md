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
  `user`. A golden run imported from a file also counts as
  `untrusted_external`, whatever trigger the file names.
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
  <span v-pre>`${ }`</span>, a spread such as `...results`) counts as reading
  every node that ran. So does an expression with a comment or a regular
  expression in it.
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
  have no origin recorded and add nothing. A save from a run that does not
  track labels never drops labels already stored: they stay, and
  `untrusted_external` is added because the new content has an unknown
  origin (a row with no labels stays without). A cached tool result always counts
  as `untrusted_external`, whatever its row holds.

On Postgres, these labels are stored by the same migration; everything else
above works the same on both databases.

## Data destinations

A data destination is a place your workflows send data: a model provider, an MCP server, a connector or a plain web address. L2M sorts every destination into one of four tiers, from nearest to furthest:

| Tier | Meaning |
|---|---|
| **Local** | This machine (`localhost`, `127.0.0.0/8`, `::1`) |
| **Private network** | Your own network: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `fc00::/7`, link-local addresses, and names ending in `.internal` or `.local` |
| **Approved vendor** | A provider you have a contract with. The default hosts of OpenAI, Anthropic, Google Gemini and Azure OpenAI (`*.openai.azure.com`) are vendors out of the box |
| **Public** | Everything else, including every destination nobody has classified |

Destinations do nothing on their own. They only matter once a guard profile has **destination rules** ("card numbers, IBANs and national ids may go no further than the private network"). Until then, classifying destinations changes no verdict and no run.

### The Data destinations tab

Open **Security → Data destinations**.

- **Your destinations** lists the rows an admin added: what each one matches, its tier, its region and the data classes it is approved to hold. **Add destination** opens the form.
- **Not classified yet** lists the providers, MCP servers, web addresses and connectors your workflows and MCP servers are configured to reach that nothing covers, so they count as public. **Classify** opens the form already filled in, host included, with the tier it has today (public); pick a nearer tier and save. The list is worked out from configuration only (no traffic is stored), shows hosts only (never paths, queries or credentials), and shows only workflows and MCP servers you can read. When a call goes over the network but its host cannot be read (a templated base URL, or a connector whose host is kept in a secret) it is listed as "host not known yet" or "Host is set in a secret" and counts as public: a row for the provider alone never covers it. Add a row with the real host to classify it.

Host names can be typed in any one alphabet (`bücher.example` is stored as `xn--bcher-kva.example`, and the page tells you). A name that mixes alphabets in one label, such as Latin with Cyrillic, is refused because that is how lookalike names are made; enter it in one alphabet or as `xn--` punycode.
- **Built-in** shows the read-only rows every deployment has. Admins can **Override** one: the form opens with its host and tier filled in, and a region under Advanced. Your row for the same host or range wins.

Everyone signed in can see the tab. Only admins add, change or remove destinations, and every change is written to the audit log (`data_destination.created`, `.updated`, `.deleted`).

### What a destination matches

| Kind | Matches on |
|---|---|
| Model provider | The provider id (for example `openai`), best together with the host it calls |
| MCP server | The registry server id, its host, or both |
| Connector | The connector type, best together with its host |
| Web address | An exact host (`api.example.com`), a wildcard (`*.corp.example`, which covers subdomains but not `corp.example` itself) or an IP range (`10.20.0.0/16`) |

Host and range rows apply to every kind: an MCP server at `10.1.2.3` is private because of the `10.0.0.0/8` row.

**Without a host a row can only make matching calls stricter.** Whoever builds a workflow chooses the host a provider, MCP server or connector calls, so a row that names only an id or a connector type never loosens what that host resolves to on its own. For example, a row "provider `openai_compatible` is private" does not make a node pointed at `api.together.xyz` private: the call is judged by the stricter of the row and the host (public here), and such a row never lends its region or approved data classes to a host that resolves further out. Add the host to the row (`openai_compatible` at `llm.corp.example`) to classify your in-house server. A row with an id and a host is authoritative for that host.

When several rows match, the most specific one wins: an id with a host beats an exact host, an exact host beats a wildcard, a longer wildcard beats a shorter one, and a wildcard beats an IP range (the narrowest range wins among ranges). Your row beats an equally specific built-in. If two of your rows are equally specific, the stricter tier wins. A request that was redirected is judged by its strictest hop. A destination nothing matches is public, and so is a host that is not a plain host name (anything with `@`, a path or other URL parts).

### Advanced: region and approved classes

Under **Advanced** in the form:

- **Region**: a tag such as `eu-west-1`. Tags are lower-cased and joined with dashes (`EU West 1` becomes `eu-west-1`). A rule that allows region `eu` covers `eu-west-1` and `eu-central-1`, but not `europe`. A destination with no region is `unknown`, which a region rule never allows unless it lists `unknown`. Regions apply only to vendor and public destinations: this machine and your private network always pass a region check.
- **Approved data classes**: classes this destination may hold whatever its tier, for example `email` for your CRM vendor. A destination rule never fires for a class the destination is approved to hold.

### Destination rules in a profile

Destination rules live in the profile document under `destinations.rules`. Each rule says which data it covers (`when`: data classes and/or provenance labels; any match counts), where that data may go (`allow`: the furthest tier, and optionally regions) and what happens otherwise (`action`: block, redact, mask, protect, require approval or review; `shadow: true` only records it):

```json
{
  "destinations": {
    "rules": [
      {
        "name": "Keep sensitive data in-house",
        "when": { "dataClasses": ["card_number", "iban", "us_ssn", "national_id", "credential"] },
        "allow": { "maxTier": "private" },
        "action": "block",
        "shadow": true
      }
    ]
  }
}
```

A profile without `destinations` keeps its hash and behaves exactly as before. The profile editor shows a profile's destination rules as plain sentences; change them with **Edit as JSON**.

The data classes a rule sees are the ones found in the outgoing content plus the ones the data's labels carry. When a class is carried only by the labels (it came from somewhere sensitive but is not in the text), there is nothing to redact, mask or protect, so those actions fall back to the profile's **No protection provider** setting when that is block or require approval, and to block otherwise (a rule written to keep data in never lets it out). The verdict says it was "matched by where the data came from, not found in the text".

### Limits

- Destination rows are stored in SQLite. On Postgres the destination routes answer 501 in this release.
- In this release destination rules are validated, stored and shown, but not yet applied to model, MCP or outbound calls: writing them changes no run.
