---
title: "Model won't call tools: why it answers in text instead"
sidebarTitle: "Model won't call tools"
description: "The model answers in text instead of calling a tool. Check what was sent, tool support, tool choice, descriptions, tool count and the prompt, in order."
level: intermediate
about: tool-calling
related: [tool-calling, mcp-tool, agent-loop, context-window, toolset]
---

# Model won't call tools: why it answers in text instead

The model replied with plain text, or with text that only looks like a tool call, when you expected it to use a tool. Check four things in order: the tools were in the request at all, the model and the server in front of it support tool calling, the tool choice lets the model decide, and the tool's name, description and the prompt make the tool the obvious next step.

## What it means

<Term id="tool-calling">Tool calling</Term> works the same way across providers. The request carries a list of tool definitions: a name, a description and a JSON Schema for the arguments. The model can answer in text, or return a structured tool call that names one of those tools with arguments. The client runs the tool and sends the result back.

Whether the model must call a tool is set by a `tool_choice` parameter, with similar options at each provider:

| Behaviour | OpenAI | Anthropic | Gemini (`functionCallingConfig.mode`) |
|---|---|---|---|
| The model decides (the default) | `auto` | `auto` | `AUTO` |
| It must call some tool | `required` | `any` | `ANY` |
| It must call one named tool | the function's name | `tool` with a name | `ANY` with allowed names |
| No tools | `none` | `none` | `NONE` |

Under the default, answering in text is a legitimate choice. If the model believes it already knows the answer, or the tool's description does not match the request, it answers. Anthropic's tool-use guide calls detailed descriptions "by far the most important factor in tool performance". Forcing a tool is possible, but not on every model: the same guide says not every model and setting supports forced tool use.

## Causes (most to least likely)

1. **No tools were sent.** Tool calling is turned off, no tools are attached, or listing the server's tools failed and the client carried on without them. The model cannot call a tool it was never shown.
2. **The model or its server does not support tool calling.** Some models were not trained for it, and some OpenAI-compatible servers only pass tools to models whose chat template supports them. The symptom is often a reply whose text contains something like `{"name": "search", "arguments": {...}}`: the model tried, but in plain text, which the client treats as an answer.
3. **A test model.** Echo and mock models used for smoke tests never call tools.
4. **The description does not match the request.** The name is cryptic, the description is one vague line or was cut short, or two tools look alike and the model picks neither.
5. **Too many tools.** The right tool is buried in a long list, or a shortlist chosen for the request left it out.
6. **The prompt steers away.** "Answer briefly from what you know", or no mention at all of when to use the tools. Small models are especially literal about this.
7. **The question does not need a tool.** "What is a refund?" can be answered from training data. "What is the status of refund R-1182?" cannot. Test with the second kind.

## How to check

**Look at what was sent.** Find the request your client made to the model provider, or the client's own record of which tools the agent was given, and confirm the tool is in it with a sensible description. If it is not there, the problem is upstream of the model: see [MCP server shows no tools](/learn/troubleshooting/mcp-server-shows-no-tools).

**Test the model on its own.** Send one request with one simple tool and a tool choice that requires a call. This uses the OpenAI-compatible chat completions format, which many servers accept; set `BASE_URL`, `API_KEY` and `MODEL` for the server you use:

```bash
curl -s "$BASE_URL/chat/completions" \
  -H "Authorization: Bearer $API_KEY" -H "Content-Type: application/json" \
  -d '{
    "model": "'"$MODEL"'",
    "messages": [{"role": "user", "content": "What is the weather in Leeds?"}],
    "tools": [{"type": "function", "function": {
      "name": "get_weather",
      "description": "Current weather for a city. Use it for any question about weather now.",
      "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}}],
    "tool_choice": "required"
  }' | jq '.choices[0].message | {tool_calls, content}'
```

- `tool_calls` filled in: the model and server support tool calling. Run it again with `"tool_choice": "auto"`. If it still calls the tool, the model is fine and the cause is in your tools or prompt (causes 4 to 7).
- `tool_calls` null and the JSON in `content`: the model or server does not support structured tool calls (cause 2). Try another model, or check the server's documentation for a tool-calling option.
- An HTTP error about `tool_choice` or `tools`: this model or endpoint does not accept them.

**Compare with a model you trust.** Swap in a hosted model known to call tools, with the same tools and prompt. If it calls the tool, the original model is the cause.

## Fix

- **Nothing sent**: turn tool calling on, attach the tools, and fix the listing error first.
- **No support**: use a model that supports tool calling, or the server's tool-calling mode for that model. Prompting a model to "reply in JSON" is not the same thing: the client still sees text.
- **Description**: write what the tool does, when to use it and when not to, and what each argument means. Put the most important words first. Give similar tools clearly different names and say which system each one reaches.
- **Too many tools**: give the agent only the tools its job needs. [Too many tools](/learn/agents/too-many-tools) covers how.
- **Prompt**: say when a tool must be used: "For any question about an order, call `get_order` first. Never guess an order's status."
- **Forced choice**: where your client lets you set `tool_choice` to `required` or a named tool, use it for steps that must always call a tool, such as a classifier. Then a text answer is no longer possible, so check the model supports it.

## If you run agents in L2M

- **Tool Calling** on the Agent node is on by default. Off, the agent sends no tools and ignores any tool call.
- **Which tools are sent.** An agent gets the tools of the MCP Tool and Workflow Tool nodes on its `tool` port, plus `agent_clarify`, the session cache tools when there is a `session_id`, and `think` when that option is on. If one server's tool listing fails, the agent runs without that server's tools and the API log says `Tool discovery failed`. The node's activity shows the tool names the agent was given.
- **Tool choice is automatic.** For OpenAI, Azure OpenAI and OpenAI-compatible servers, the agent sends `tool_choice: "auto"`. For Anthropic and Gemini it sends none, so their default, automatic choice, applies. The Agent node has no setting to force a tool. To force one step, call the tool with an MCP Tool node in the workflow itself, before or after the agent.
- **Only real tool calls count.** L2M reads tool calls from the provider's structured field, such as `tool_calls` in the OpenAI-compatible format. A tool call written as text in the reply becomes the agent's final answer.
- **Descriptions are shortened.** Each description is cut to 280 characters and each schema keeps its first 8 top-level arguments, so put what matters first ([how the context is kept small](/runtime/agent-loop#how-the-context-is-kept-small)).
- **Shortlists can leave a tool out.** Only an agent with no tool nodes, whose servers are listed in its JSON config, gets a keyword shortlist: at most 6 tools that share words with the user's message, or the first 8 when none do. A follow-up such as "do the same for the next one" may match nothing useful. Attach MCP Tool nodes and select the tools instead.
- **Policies hide tools.** A tool policy or the **No write tools** switch can remove a tool before the model sees it; the Trace tab lists hidden tools ([reading the trace](/product/mcp-tool-policy#reading-the-trace)).
- **The echo test model never calls a tool**, so an agent on it always answers on its first round. Use it to check the wiring, not the tools.
- **An empty reply** is not accepted as an answer: the runtime asks the model to answer or call a tool, and tries again.

Related errors: [MCP server shows no tools](/learn/troubleshooting/mcp-server-shows-no-tools), [agent stuck in a tool loop](/learn/troubleshooting/agent-stuck-in-tool-loop) (the opposite problem), [tool result too large](/learn/troubleshooting/mcp-tool-result-too-large).

## Further reading

- [Function calling](https://developers.openai.com/api/docs/guides/function-calling) (OpenAI docs): `tool_choice` options and writing function descriptions
- [Define tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools) (Anthropic docs): tool descriptions and forcing tool use
- [Function calling with generateContent: modes](https://aistudio.google.com/docs/function-calling?generate-content=true#function_calling_modes) (Google AI docs): the `function_calling_config` modes `AUTO`, `ANY` and `NONE`, and `allowed_function_names`
- [MCP specification, 2025-11-25: Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) (modelcontextprotocol.io): tool definitions and the model-controlled interaction model
- In L2M: [Agent loop](/runtime/agent-loop), [Too many tools](/learn/agents/too-many-tools), [MCP tool policy](/product/mcp-tool-policy#reading-the-trace)
