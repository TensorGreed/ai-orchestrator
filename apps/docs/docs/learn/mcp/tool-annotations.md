---
title: "MCP tool annotations: read-only, destructive and hints"
sidebarTitle: "MCP tool annotations"
description: "What readOnlyHint, destructiveHint, idempotentHint and openWorldHint mean, why the spec calls them untrusted, and how to use them in tool rules safely."
level: intermediate
about: tool-annotations
related: [tool-annotations, write-tool, mcp-tool-policy, rug-pull, least-privilege]
---

# MCP tool annotations

MCP <Term id="tool-annotations">tool annotations</Term> are optional hints a server attaches to each tool in its `tools/list` answer: `readOnlyHint` says the tool changes nothing, `destructiveHint` that it may delete or overwrite, `idempotentHint` that repeating a call has no further effect, and `openWorldHint` that it reaches outside systems. A client can use them to decide which calls need a person's confirmation and which are safe to retry. The specification is clear that they are only hints: a client must treat them as untrusted unless the server is trusted, and should check or override them for the tools that matter.

## The four hints

An <Term id="mcp-tool">MCP tool</Term> definition has a name, a description, an input schema and an optional `annotations` object. The 2025-11-25 schema defines five fields in it: a display `title` and four booleans. Each boolean has a default that applies when the server leaves it out:

| Hint | If true | Default when missing |
|---|---|---|
| `readOnlyHint` | "the tool does not modify its environment" | `false` |
| `destructiveHint` | "the tool may perform destructive updates to its environment"; if false, it "performs only additive updates" | `true` |
| `idempotentHint` | "calling the tool repeatedly with the same arguments will have no additional effect on its environment" | `false` |
| `openWorldHint` | "this tool may interact with an 'open world' of external entities"; if false, its domain is closed | `true` |

`destructiveHint` and `idempotentHint` are "meaningful only when `readOnlyHint == false`". A tool that changes nothing cannot be destructive, and repeating it is harmless anyway. The schema's example for `openWorldHint`: a web search tool's world is open, a memory tool's is not.

Here is how a ticket server might describe three of its tools:

```json
{
  "tools": [
    { "name": "search_tickets", "inputSchema": { "type": "object" },
      "annotations": { "readOnlyHint": true, "openWorldHint": false } },
    { "name": "add_label", "inputSchema": { "type": "object" },
      "annotations": { "readOnlyHint": false, "destructiveHint": false, "idempotentHint": true } },
    { "name": "delete_ticket", "inputSchema": { "type": "object" },
      "annotations": { "readOnlyHint": false, "destructiveHint": true, "idempotentHint": true } }
  ]
}
```

Notice the defaults. A tool with no annotations at all reads as a <Term id="write-tool">write tool</Term> that may be destructive, is not idempotent and reaches the open world. That is the cautious reading, and it is deliberate: a missing hint should never make a tool look safer.

## Hints, not guarantees

The schema says it directly: "all properties in ToolAnnotations are **hints**. They are not guaranteed to provide a faithful description of tool behavior (including descriptive properties like `title`). Clients should never make tool use decisions based on ToolAnnotations received from untrusted servers."

The tools page of the specification makes it a requirement: "clients **MUST** consider tool annotations to be untrusted unless they come from trusted servers."

The reason is simple. The server writes the annotations, and nothing checks them against what the tool does. A careless server can forget to mark a delete as destructive. A malicious one can label `export_all_customers` read-only so a client lets it through without asking. The OWASP MCP Security Cheat Sheet puts it as "tool annotations are hints, not enforcement", and adds that "a tool's read/write label alone may not establish the risk": a read-only tool that sends your files to a search API still leaks them.

So trust the hint only as far as you trust the server, and only in the direction that makes you more careful. A tool marked destructive deserves caution even if the mark is wrong. A tool marked read-only from a server you have not reviewed deserves a look before you rely on the mark.

## Where hints help

Used that way, annotations save real work:

- **Confirmations.** The specification says there SHOULD always be a <Term id="human-in-the-loop">human in the loop</Term> with the ability to deny tool invocations, and that clients SHOULD ask for confirmation on sensitive operations. Asking before every call wears people out. Asking before write tools, and letting read-only tools run, puts the confirmations where they count.
- **Retries.** When a connection breaks before an answer arrives, the client does not know whether the call ran. Sending a read-only or idempotent call again is safe. Sending `create_invoice` again may bill the customer twice.
- **Review.** A list of tools sorted by hint shows which tools need a decision first: the destructive ones, then the other write tools, then the open-world ones.
- **Display.** `title` gives people a readable name, such as "Delete ticket" instead of `delete_ticket`.

## Classify tools yourself when a server does not

Many servers send no annotations, and some send wrong ones. Whoever runs the client should therefore keep its own classification of every tool that matters, with three outcomes:

1. **Your own mark.** You reviewed the tool and decided it is read-only or a write tool. Your mark wins over the server's hint in both directions.
2. **The server's hint**, when you have not marked the tool and the server sent `readOnlyHint`.
3. **Write tool**, when neither says anything.

Review in order of damage: destructive tools first, then tools that send data out, then the rest. A `delete_records` tool labelled read-only should be marked as a write tool. A `get_report` tool with no annotations can be marked read-only once you have read what it does.

## Rules that use annotations

Once every tool has a classification, rules can refer to classes instead of names. That keeps working when a server adds a tool next month:

- **"Deny destructive tools for operators."** Matches every tool that is not read-only and does not declare `destructiveHint: false`, on every server.
- **"No write tools in this workflow."** A support bot that only looks things up gets the read-only tools and nothing else.
- **"Ask a person before any write tool."** Read-only tools run freely; the rest pause for approval.
- **"Require approval for open-world tools when the run holds sensitive data."** Combine the hint with what the run has seen.

Three habits keep such rules safe:

- **Read missing hints with the spec's defaults.** A tool with no annotations should match "destructive", not slip past it.
- **Let deny rules widen and allow rules narrow.** If a hint and your own knowledge disagree, a deny or approval rule should match when either says the tool is risky, and an allow rule only when both say it is safe.
- **Make the classification a person's decision for anything that matters.** A rule that relies on a server's word is only as strong as that server.

These rules are a form of <Term id="least-privilege">least privilege</Term>: the agent gets the kind of access its task needs, by class, before you write any per-tool exceptions.

## Watch for changes (rug pulls)

A server can change a tool after you approved it. The OWASP cheat sheet calls this a <Term id="rug-pull">rug pull</Term>: "A server changes its tool definitions after initial user approval, turning a trusted tool malicious." Annotations are part of the definition, and the cheat sheet warns that "a flipped readOnlyHint or destructiveHint can change client approval behavior without any visible description change."

What to do about it:

- **Snapshot the tool list** and diff each new `tools/list` against the last one, annotations included. OWASP suggests hashing "the complete tool definition (including inputSchema, outputSchema, and annotations)" and requiring review when it changes.
- **Treat a hint that moves towards "safe" as a review item.** `readOnlyHint` going from `false` to `true` should make you look, not relax.
- **Pin the classification of tools you care about** with your own mark, so a change on the server cannot reclassify them.
- Keep in mind what a hash cannot see: in OWASP's words, it "detects metadata changes, not changes to server code or behavior behind an unchanged definition."

## Tool annotations in L2M

L2M reads annotations from both its HTTP and <Term id="stdio-transport">stdio</Term> adapters and keeps only the five known fields, with the right types. Each one shows as a chip on the server's Tools table and in the MCP Tool node's inspector. Using them for rules is optional: with no rules and no switches turned on, annotations change only one thing, which calls L2M sends again after a broken connection (see **Retries** below).

- **[Read-only classification](/product/mcp-tool-policy#read-only-classification).** Every tool is read-only or a write tool: an admin's **Mark read-only** or **Mark write** override first, then the server's `readOnlyHint`, otherwise a write tool. A server that claims both `readOnlyHint: true` and `destructiveHint: true` counts as a write tool. Overrides exist only for registered servers; tools on servers configured inline on a node are classified by their annotations alone.
- **[Annotation conditions](/product/mcp-tool-policy#annotation-conditions).** Optionally, a <Term id="mcp-tool-policy">tool policy</Term> rule can match only `destructive`, `read_only`, `idempotent` or `open_world` tools (or their opposites). Missing hints take the spec's defaults, so a tool with no annotations counts as destructive and open world, and an override replaces `readOnlyHint`. For open world, L2M also takes into account where the server sends data, unless an admin set an open-world override for the tool.
- **[No write tools](/product/mcp-tool-policy#no-write-tools).** A per-workflow switch that blocks every write tool, by the classification above, for agents and MCP Tool nodes. The **Ask before write tools** switch is stricter: it pauses agents for a person's approval before every tool an admin has not marked read-only (L2M's own read-only tools aside), and ignores `readOnlyHint` altogether, because any server can claim it ([approval before write tools](/product/approvals#approval-before-write-tools)).
- **Retries.** By default, after a broken connection or a timeout, the HTTP and stdio clients send a tool call again only if the tool is read-only or idempotent, by the same classification. Other calls fail as `outcome_unknown`.
- **Schema history.** The [MCP server registry](/product/mcp-server-registry#what-counts-as-a-breaking-change) stores a snapshot of each registered server's tool list, annotations included, and diffs every change. An annotation change is recorded as a compatible change: it does not trigger the optional **Block runs on breaking change** brake. To stop a server from reclassifying a tool, give the tool an override.

To see the classification at work with no API key, import the [zero-key MCP agent recipe](/recipes/zero-key-mcp-agent). The built-in mock server marks `get_current_time` read-only and sends no annotations for `calculator`, so `calculator` counts as a write tool. Turn on **No write tools** and run it: the trace's tool policy block lists `calculator` as hidden with reason `no_write_tools`. The [Govern MCP tools](/guides/govern-mcp-tools) guide walks through review, rules and enforcement.

See also: [Least privilege for agents](/learn/security/least-privilege-for-agents).

## Further reading

- [MCP specification, 2025-11-25: Schema reference, ToolAnnotations](https://modelcontextprotocol.io/specification/2025-11-25/schema#toolannotations) (modelcontextprotocol.io)
- [MCP specification, 2025-11-25: Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) (modelcontextprotocol.io)
- [OWASP MCP Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/MCP_Security_Cheat_Sheet.html) (OWASP)
- In L2M: [MCP tool policy](/product/mcp-tool-policy), [Tool annotations in the registry](/product/mcp-server-registry#tool-annotations)
