---
title: "Content rules tools: detect, redact, restore"
description: "MCP gateway tools to detect, redact and restore sensitive data: risk levels, readable placeholders, expiring redaction maps, reveal rules per client."
---

# Content rules tools on the MCP gateway

An admin can add the **content rules tools** to an [MCP gateway](./mcp-gateway.md) toolset. Clients of that toolset then get three tools that run the same data checks as [content rules](./content-rules.md):

| Tool | What it does | Read-only hint |
|---|---|---|
| `detect_sensitive_data` | Finds sensitive data and gives a risk level per input | yes |
| `redact_sensitive_data` | Replaces sensitive data; reversible styles return a `redaction_id` | no (it keeps a map) |
| `restore_sensitive_data` | Turns placeholders and vault tokens back, only as reveal rules allow the client | no |

The tools are off by default. A toolset without the member lists none of them, and a deployment that never adds it sees no change.

## Turning them on

On the **MCP** page, under **Toolsets**, an admin edits a toolset and ticks **Offer detect_sensitive_data, redact_sensitive_data and restore_sensitive_data**. Pick the **Rule set** whose data checks the tools use: its dictionaries, data detector options and allow-list. With **None (built-in data checks only)** the tools use the built-in data detector alone, and a call can still name a rule set from the toolset's chain (the project's enforced rule set, the toolset's and the client's rule sets) with `rule_set_id`. Over the API this is a toolset member `{ "kind": "content_rules", "ruleSetId": "pii" }` (`ruleSetId` may be `null`); a toolset takes at most one, and a rule set id that does not exist answers 400. Only admins can change toolsets.

Who can call the tools is set like any other gateway tool: only clients scoped to the toolset, and [tool rules](./mcp-tool-policy.md) can allow or deny them by name under the server label `Content rules` (use `l2m-content-rules` as the rule's server). Rules are checked with the call's arguments and the session's data labels. **Approval rules are not supported for these tools:** a rule with the effect `require_approval` that matches one of them refuses the call with a tool error that says so (and writes `mcp_gateway.tool_denied`), rather than holding it for an admin. Use allow and deny rules for them. Calls count against the client's [budgets and rate limits](./mcp-gateway.md#budgets-and-rate-limits) like any other call. The toolset's and client's own rule sets do not also check these calls' arguments and results: the tools exist to handle sensitive data.

## Inputs

Each tool takes exactly one of:

- `text`: one string;
- `texts`: up to 100 strings, each with its own result;
- `value`: any JSON value; every string in it is processed, the shape is kept, and findings carry a path such as `$.customer.contact` (keys that look like values are written by position, never by name). Object keys are scanned too (path ending `{key}`); redact refuses a value whose keys hold sensitive data, since keys cannot be rewritten. Values nested deeper than 32 levels are refused.

Strings may be up to 1,000,000 characters. `detect_sensitive_data` and `redact_sensitive_data` also take:

- `rule_set_id`: a rule set this toolset makes available (the member's rule set, or one in the toolset's chain). Any other id is a tool error.
- `entity_types`: only these data classes, such as `email`, `phone`, `card_number`, `iban`, `us_ssn`, `national_id`, `credential`, `private_key`, `jwt` or `ip_address`. Person names, locations and street addresses (`person_name`, `location`, `street_address`) are looked for only when named here or when the rule set runs [`data.entities`](./content-rules-engine.md#names-locations-and-street-addresses); they are never part of "every class". Their placeholders read `[PERSON_NAME_1]`, `[LOCATION_1]` and `[STREET_ADDRESS_1]`.
- `allow_list`: up to 100 values never reported in this call, on top of the rule set's [allow-list](#allow-list).

## detect_sensitive_data

The result has, per input, its `riskLevel`, its `findings` (data class, `start` and `end` positions, score and a masked preview such as `j•••••••@e••••••.com`) and counts per class, and an overall `riskLevel`. Values are never returned.

| Risk level | When |
|---|---|
| `high` | a private key, credential, JWT, card number, IBAN, US SSN or national id with a score of 0.8 or more |
| `medium` | any other finding with a score of 0.6 or more (person names, locations and street addresses included) |
| `low` | only findings below 0.6 |
| `none` | no findings |

## redact_sensitive_data

`style` picks the replacement:

| Style | Example | Reversible |
|---|---|---|
| `placeholder` (default) | `[EMAIL_1]`, `[PHONE_1]` | yes, with the `redaction_id` |
| `token` | `tok_email_…` (token vault) | yes |
| `mask` | `j•••••••@e••••••.com` | no |
| `hash` | `hash_email_3f…` | no |

- **Placeholders** are numbered per data class. The same value keeps its placeholder across all inputs of the call; a placeholder already in the text (someone typed `[EMAIL_1]`) is never reused, so restoring cannot turn it into a value.
- **Tokens** are token vault tokens of the toolset's project (a toolset without a project has its own scope). The restore tool turns them back only with their `redaction_id`; a Reveal node in that project can also reveal them, as its reveal rules allow.
- **Hashes** are keyed per project: equal values give equal hashes in one project and unrelated ones in another. They need the deployment's master key.

A reversible style returns a `redaction_id` (`red_…`). The map behind it stays on the server: sealed with the master key in the `content_redactions` table, bound to the calling client and the toolset's project, and readable until it expires. `ttl_seconds` (at least 60) shortens its life; the longest is `CONTENT_REDACTION_TTL_SECONDS` (default 86400, one day; at most 30 days). Expired maps are unreadable; they are removed as maps are written and restored and by the retention purge (see [Retention and data-subject requests](#retention-and-data-subject-requests)).

The response holds the redacted input, the findings summary (classes, counts, masked previews) and the risk levels. Every redact and detect call with findings writes one rule event per data class, with the placement `gateway`, the count and up to five masked previews as evidence, and the call's `mcpgw_` execution id.

## restore_sensitive_data

Give the redacted text (or `texts` or `value`) and the `redaction_id`. Only placeholders and vault tokens that this redaction issued are restored; any other token stays as it is (`unknown_token`).

Nothing is restored unless a reveal rule allows it. Reveal rules name gateway clients by id:

```json
"reveal": {
  "rules": [
    { "name": "Support agent", "dataClasses": ["email", "phone"], "subjects": { "gatewayClients": ["mcpc_…"] } }
  ]
}
```

In the rule set editor this is the **Gateway client ids** field of **Add a reveal rule**. Saving or importing a rule set that names a client this deployment does not have succeeds with a warning (`warnings` in the response, shown after **Save**): the rule matches no client until one with that id exists, and refusing the save would break moving rule sets between deployments. The rules come from the member's rule set and the rule sets in the toolset's chain; when the project's enforced rule set has a `reveal` block, it is the only source, as for [Reveal nodes](./content-rules.md#reveal-node). A gateway client matches only rules that name its id, never rules for roles, users or service accounts. A rule with `requireApproval` withholds its classes (reason `approval_required`), because nobody can approve while the client waits.

- **Partial restores.** Classes no rule allows stay as placeholders or tokens; `withheld` lists them with a count and a reason (`no_rule`, `approval_required`, `other_project`). `restoredClasses` lists what came back.
- **Scope.** A `redaction_id` made by another client, or through a toolset of another project, answers `Unknown or expired redaction_id`, the same as an expired or made-up one. Tokens that workflow runs, rule sets on the gateway or other redactions issued are never restored by this tool.
- **Audit.** Every restore call writes the audit entry `mcp_gateway.content_restore`: the client, the toolset, a hash of the `redaction_id`, counts per class and the rule that allowed each, or why an unknown id was refused; never values. A restore that restored or withheld something also writes rule events with placement `gateway` and action `reveal`, with token hashes as evidence. If the audit entry cannot be written, nothing is restored.
- **Session labels.** Restored values are sensitive again: on a toolset that tracks outside content per session, the session gets the `sensitive` label and the restored classes, so [rules on data labels](./data-labels-and-destinations.md) apply to the client's later calls.

## Placeholders in workflow runs

The same placeholder style is a protection provider in runs (Protection Provider nodes and `redact` actions with `"providerId": "placeholder"`). In a run, placeholders always carry a random tag of that run after a dot: `[EMAIL_1.K3F9QX]`, `[PHONE_2.K3F9QX]`. The tag stops text that reaches the run from outside (a webhook, a tool result, a model's answer) from naming a placeholder the run hands out later and having a Reveal node fill in someone else's value. Gateway redactions use plain `[EMAIL_1]`: their map belongs to one client, and every placeholder already in the call's input is reserved.

A run keeps its placeholders in one sealed map (`content_redactions`, id `run:<execution id>`), expiring like gateway maps. A resumed run that writes the map at the same time as the original never loses a mapping: each write is conditional on the map's version, and a writer that loses re-reads the map and numbers again from there. If the map keeps changing under it, the placeholder is not issued and the rule set's protection fallback applies (by default the content is blocked). A Reveal node that finds a placeholder it does not know leaves it as it is.

## Retention and data-subject requests

Redaction maps hold sealed originals, so they are treated like other personal data:

- **Expiry and purge.** Each map ends at its own expiry. Expired maps are deleted as maps are written and restored, and by every [retention purge](../operations/data-retention.md) (class **Redaction maps**).
- **Data-subject deletion.** A [deletion request](../security/data-subject-requests.md) opens every unexpired map and deletes those that hold the person's value, both gateway maps and run placeholder books (a run whose history holds only placeholders is not found by the search, but its map is). Vault tokens a map issued go through the same check as other tokens: the person's are deleted. Deleting a run deletes its placeholder book. Maps sealed under another master key cannot be opened and are left to expire.
  - A map is matched when one of its originals equals the person's value after the same normalisation as the search (case and surrounding spaces ignored, phone numbers compared by their digits); a value only inside a longer original is not matched, and that map is left to expire.
  - A deleted map takes all of its placeholders with it, including those of other people in the same run or gateway session: they stay as placeholders and cannot be revealed.
  - A run still in progress keeps going after its book is deleted. Its earlier placeholders stop resolving, and later ones go into a new book under a new tag; the deleted mappings are never written back.
  - While any legal hold is active, the maps wait like vault tokens do, and releasing the hold runs the deletion again.
- **Exports.** A data-subject export does not include redaction maps (listed under not covered in its manifest).
- **Backups.** Maps are not exported by `db:export`; a restore brings none back.

## Allow-list

A rule set can list values its data checks never report, for example a support address or a test card number. In the rule set editor this is the **Allow-list** section; in JSON:

```json
"allowList": {
  "values": ["support@acme.example", "4111 1111 1111 1111"],
  "patterns": ["*@example.com"]
}
```

Values match without case, spaces or dashes. Patterns use `*` for any run of characters and `?` for one. Up to 500 values and 100 patterns, each up to 256 characters; findings longer than 512 characters are never allow-listed. The allow-list applies to every finding with a data class, in workflows and on the gateway, and saving it makes a new rule set version like any other change.

## IP addresses

The data detector can report IPv4 and IPv6 addresses as the data class `ip_address`. It is off in the built-in rule set. Name `ip_address` in `entity_types` for one call, or list it in the data detector's `include` option to turn it on for a rule set:

```json
{ "id": "dlp.patterns", "threshold": 0.6, "options": { "include": ["ip_address"] } }
```

Version strings such as `v1.2.3.4`, `version 1.2.3.4` or `1.2.3.4-beta` are skipped, and so are numbers that are not valid addresses.

A masked IP address keeps nothing of the address: every IPv4 address shows as `•••.•••.•••.•••` and every IPv6 address as `••••:••••:••••:••••:••••:••••:••••:••••`, so the preview does not reveal how long each part is.
