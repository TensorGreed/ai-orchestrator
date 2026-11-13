---
title: "MCP tools, resources and prompts: what each is for"
sidebarTitle: "Tools, resources and prompts"
description: "When an MCP server should offer a tool, a resource or a prompt, who decides each is used, and what output schemas, tool errors and elicitation add."
level: beginner
about: mcp-tool
related: [mcp-tool, mcp-resource, mcp-prompt, structured-tool-output, elicitation, sampling]
demo: wf-demo-support-agent
demoRecorded: true
---

# MCP tools, resources and prompts: what each is for

An MCP server can offer three kinds of things, and the specification tells them apart by who decides when each one is used. <Term id="mcp-tool">Tools</Term> are model-controlled: the model chooses to call them. <Term id="mcp-resource">Resources</Term> are application-driven: the host application decides which data to read and put in front of the model. <Term id="mcp-prompt">Prompts</Term> are user-controlled: a person picks a ready-made template. A quick rule for server authors: an action or a lookup the model should choose belongs in a tool, data the application attaches is a resource, and a task a person starts on purpose is a prompt.

## Who decides: the short version

Take a server in front of an issue tracker. It might offer all three:

| Primitive | The specification's word | Who decides | Typical interface | Issue tracker example |
|---|---|---|---|---|
| Tool | model-controlled | The model, during a conversation | Hidden behind the model's tool calls, with approval for risky ones | `search_issues`, `create_issue` |
| Resource | application-driven | The host application, or the person through its interface | A file picker, a search box, automatic context | `issue://4211`, the project's label list |
| Prompt | user-controlled | The person | A slash command or a menu | "Triage this bug report" |

All three pages of the specification add the same caveat: implementations "are free to expose" each primitive "through any interface pattern that suits their needs". The control model is a design intent, not something the protocol enforces. An application may let its model pick resources, for example. But the intent tells a server author what each primitive is for.

## Tools: actions the model chooses

The tools page says tools are "**model-controlled**, meaning that the language model can discover and invoke tools automatically based on its contextual understanding and the user's prompts". A tool has a `name`, a `description`, an `inputSchema` (JSON Schema for its arguments), and optionally an `outputSchema` and <Term id="tool-annotations">annotations</Term>, hints such as "this tool only reads".

Because the model chooses, the person needs a way to stop it. In the specification's words, "there **SHOULD** always be a human in the loop with the ability to deny tool invocations". It also asks applications to show which tools the model can see, mark when one runs, and confirm risky operations. Its security notes add more client duties: display a tool's arguments to the person before the call goes out, check what comes back before the model reads it, and put time limits and logging on every call.

A tool result is a list of content items: text, images, audio, links to resources, or embedded resources. That last pair is the bridge between primitives. A `search_issues` tool can return `resource_link` items that point at `issue://4211`, and the application can then read the full issue as a resource.

## Resources: data the application reads

The resources page describes them as "**application-driven**, with host applications determining how to incorporate context based on their needs". Each resource has a URI, a name and, optionally, a MIME type. The client lists them with `resources/list` and reads one with `resources/read`, which returns text or base64 binary content.

The specification suggests three ways an application can use them: show them in "a tree or list view" for explicit selection, let the user search and filter them, or "Implement automatic context inclusion, based on heuristics or the AI model's selection". Other parts of the feature:

- **Templates.** A resource template such as `issue://{id}` describes a whole family of resources with an RFC 6570 URI template.
- **Change notices.** A server can announce that its list changed, and a client can subscribe to changes in one resource. (In 2026-07-28, a client opts in to these notices with `subscriptions/listen` instead.)
- **Annotations.** `audience` (`"user"`, `"assistant"` or both) and `priority` (0.0 to 1.0) help the application choose what to put in the model's context.

**Resource or tool?** If the model needs to decide, with parameters, what to look up, offer a tool. If the application should control what context the model gets, and the data has a stable address, offer a resource. Many servers offer both: a search tool to find things, and resources to read them.

## Prompts: templates a person picks

The prompts page says prompts are "**user-controlled**, meaning they are exposed from servers to clients with the intention of the user being able to explicitly select them for use", typically as commands such as slash commands. A prompt has a name, a description and named arguments. `prompts/get` with the arguments filled in returns a list of messages, each with a role (`user` or `assistant`) and content, ready to send to a model.

Prompts let a server author ship their best way of using the server. A "triage this bug report" prompt can carry the instructions, the label rules and the output format that work well with that tracker.

Prompt text comes from the server and goes straight to your model, so it deserves the same suspicion as a tool description. The specification says "Implementations **MUST** carefully validate all prompt inputs and outputs to prevent injection attacks or unauthorized access to resources." A server that changes its prompts can steer your model, which is the prompt version of <Term id="tool-poisoning">tool poisoning</Term>.

## Structured output and output schemas

Plain tool results are text that the model reads. Code that sits after a tool call needs something firmer. <Term id="structured-tool-output">Structured tool output</Term> is a JSON object in the result's `structuredContent` field. For backwards compatibility, a tool that returns one SHOULD also return the same JSON as text.

A tool can declare an `outputSchema`. Then, in the specification's words, "Servers **MUST** provide structured results that conform to this schema" and "Clients **SHOULD** validate structured results against this schema." For example:

```json
{
  "name": "get_order_status",
  "inputSchema": { "type": "object", "properties": { "orderId": { "type": "string" } }, "required": ["orderId"] },
  "outputSchema": {
    "type": "object",
    "properties": { "status": { "type": "string" }, "etaDays": { "type": "integer" } },
    "required": ["status"]
  }
}
```

A call then returns both forms:

```json
{
  "content": [{ "type": "text", "text": "{\"status\":\"shipped\",\"etaDays\":2}" }],
  "structuredContent": { "status": "shipped", "etaDays": 2 }
}
```

The specification adds a note that `structuredContent` "is server-produced result data and is unrelated to LLM "structured outputs"", the model feature that forces a reply into a schema. An output schema is a promise from the server, not a constraint on the model.

The 2026-07-28 revision loosens both schemas to allow any JSON Schema 2020-12 keywords, and lets `structuredContent` be any JSON value rather than only an object.

## Two kinds of errors

A tool can fail in two ways, and they travel differently:

- **Tool execution errors** are normal results with `isError: true`: an upstream API failed, an argument was in the wrong format, a business rule said no.
- **Protocol errors** are JSON-RPC errors: an unknown tool, a request that does not match the schema for `tools/call`, a server fault.

```json
{ "jsonrpc": "2.0", "id": 7, "result": {
  "content": [{ "type": "text", "text": "orderId must look like ORD-123456." }],
  "isError": true } }
```

```json
{ "jsonrpc": "2.0", "id": 8, "error": { "code": -32602, "message": "Unknown tool: get_order_stat" } }
```

The difference matters to the model. "Tool Execution Errors contain actionable feedback that language models can use to self-correct and retry with adjusted parameters", and clients SHOULD pass them to the model. Protocol errors "indicate issues with the request structure itself that models are less likely to be able to fix", so passing those on is optional. For server authors, the lesson is to check arguments yourself and answer with `isError: true` and a message that says how to fix the call.

## Elicitation and sampling

Tools, resources and prompts flow from server to client. Two features flow the other way: the server asks the client for something while it handles a request.

**Elicitation.** With <Term id="elicitation">elicitation</Term>, a server asks the person a question through the client, for example which of three matching accounts to use. In form mode it sends a message and a flat schema of simple fields; in URL mode, new in 2025-11-25, it sends a link for steps "that must *not* pass through the MCP client", such as a payment or a third-party sign-in. Servers "**MUST NOT** use form mode elicitation to request sensitive information such as passwords, API keys, access tokens, or payment credentials". The person can accept, decline or cancel. In 2026-07-28, elicitation is not deprecated, but its mechanics change: a server no longer sends its own request. It answers the original call with an `input_required` result, and the client retries the call with the person's answers (the Multi Round-Trip Requests pattern). The completion notification for URL mode is removed.

**Sampling.** With <Term id="sampling">sampling</Term>, a server asks the client to run a model completion for it, which lets a tool use AI "with no server API keys necessary". The client keeps control of which model answers, and the specification says there SHOULD be a human able to deny sampling requests. The 2026-07-28 revision deprecates sampling, together with roots and logging. It still works during the deprecation window, which lasts until at least the first revision released on or after 2027-07-28, but new implementations should not adopt it. The suggested migration is to "integrate directly with LLM provider APIs".

## Tools, resources and prompts in L2M

L2M follows the specification's split between who decides. Everything below works without configuration except where marked optional.

- **Tools: the model decides.** Every MCP Tool node wired to an agent's `tool` port adds its tools to what the model can call. When a call comes back with `isError: true`, the error text goes back to the model as the tool result, so it can correct itself and retry. A direct MCP Tool node in a workflow fails instead, with the server's message.
- **Structured output is validated.** When a tool declares an `outputSchema`, L2M checks `structuredContent` against it. If the object is absent or breaks the schema, the call fails, for example with `MCP tool 'get_order_status' returned structuredContent that does not match its outputSchema: /etaDays must be integer.`; inside an agent that message reaches the model like any tool error. Error results (`isError: true`) skip the check, and an output schema L2M cannot compile is ignored, with a warning. Later nodes can read fields like <span v-pre>`{{results.<node>.structured.status}}`</span> ([structured output](/product/mcp-server-registry#structured-output)).
- **Resources: the workflow decides.** L2M does not give the model a tool for reading resources. A workflow reads one with an MCP Tool node set to **Read a resource**. The URI can take values from the run, such as <span v-pre>`issue://{{vars.issueId}}`</span>, and the node passes its `text` output on ([reading a resource](/product/mcp-server-registry#reading-a-resource-from-a-workflow)). Reads are capped at 5 MiB by default (`MCP_RESOURCE_MAX_BYTES`).
- **Prompts: the builder decides.** Agent, Supervisor, LLM Call and chat model nodes have a **Server prompt** picker. The person building the workflow picks a server's prompt, fills its arguments and chooses whether it replaces the system or the user message. L2M fetches it each time the node runs, so the server's current version applies ([using a server prompt](/product/mcp-server-registry#using-a-server-prompt)). Optionally, tool policy rules can deny resource reads and prompt fetches. The node's output records which resource or prompt was used, and the Playground audits its own reads and fetches, without their contents.
- **Elicitation: a person answers, or nobody does.** L2M declares form-mode elicitation to every server. In a run someone started from the editor or Chat, the question appears as a form in Chat and under **Waiting for you** on the Runs page. Runs nobody is watching, such as webhooks, schedules and gateway calls, decline at once. A form whose field names look like credentials (token, key, password and similar) is refused whatever the trigger. URL mode is not declared ([elicitation](/product/mcp-server-registry#elicitation-a-server-asks-the-person-a-question)).
- **Sampling is off by default.** An admin can turn it on per server, with a token cap, allowed models and a per-call request limit ([sampling](/product/mcp-server-registry#sampling-a-server-asks-the-model-for-a-completion)).

When L2M is itself the server, through the MCP gateway, it offers tools only: workflows and re-exposed registry tools. It serves no resources or prompts.

The live demo shows a tool error doing its job. A support agent asks a calculator tool for `49 seats * $12 * 12 months`. The tool answers "Expression contains unsupported characters. Use digits and + - * / ( ) only.", and on the next turn the model sends `49*12*12`, which works. A scripted model produced the recording, so watching it needs no key.

<TryInDemo workflow="wf-demo-support-agent" recorded />

See also: [Testing MCP tools](/learn/testing/testing-mcp-tools), for catching a changed input or output schema before it breaks a run.

## Further reading

- [MCP specification, 2025-11-25: Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) (modelcontextprotocol.io)
- [MCP specification, 2025-11-25: Resources](https://modelcontextprotocol.io/specification/2025-11-25/server/resources) (modelcontextprotocol.io)
- [MCP specification, 2025-11-25: Prompts](https://modelcontextprotocol.io/specification/2025-11-25/server/prompts) (modelcontextprotocol.io)
- [MCP specification, 2025-11-25: Elicitation](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation) (modelcontextprotocol.io)
- [MCP specification, 2026-07-28: Key changes](https://modelcontextprotocol.io/specification/2026-07-28/changelog) (modelcontextprotocol.io)
- In L2M: [MCP server registry](/product/mcp-server-registry), [resources and prompts](/product/mcp-server-registry#resources-and-prompts), [MCP 2026-07-28 support](/product/mcp-2026-07-28)
