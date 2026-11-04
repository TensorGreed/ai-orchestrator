---
description: "Give an L2M agent Wikipedia, SearXNG or SerpAPI web search and Wolfram Alpha as built-in MCP tools, plus an optional Think step, with no extra server to run."
---

# Built-in Agent Tools

L2M ships a few tools agents often need, served by the API itself. You don't run an MCP server for them: drop a preset on an agent's `Tool` port and pick a key if the provider needs one.

| Tool | Tools the agent sees | Key | Calls go to |
|---|---|---|---|
| Wikipedia | `wikipedia_search`, `wikipedia_page` | none | `https://<language>.wikipedia.org` (default `en`) |
| SearXNG web search | `searxng_search` | optional bearer token | your SearXNG instance |
| SerpAPI web search | `serpapi_search` | SerpAPI API key | `https://serpapi.com` |
| Wolfram Alpha | `wolfram_alpha` | Wolfram Alpha AppID | `https://www.wolframalpha.com` (LLM API) |

## Add one

1. Open the node drawer from an agent's `Tool` port, or the palette.
2. Pick **Wikipedia**, **SearXNG web search**, **SerpAPI web search** or **Wolfram Alpha**. Each is an MCP Tool node pointed at the built-in `l2m-tools` adapter, with one provider set.
3. For SerpAPI and Wolfram Alpha, choose the key under **Auth Secret**. For SearXNG, set **Instance URL** to your instance; its JSON output format must be enabled (`search.formats` includes `json`).
4. For Wikipedia, set **Language edition** (`de`, `ja`, ...) if you don't want English.

The node works on its own too, outside an agent, like any MCP Tool node.

## How they are governed

The built-in tools go through the same MCP layer as any other server, so nothing about them is special-cased:

- **Tool rules** match them with server `l2m-tools` (inline node) and their tool names.
- **Labels.** Every result counts as outside content (`untrusted_external`). A rule such as *Untrusted content: write tools need approval* asks before a write tool runs after a search.
- **Read-only.** The tools declare `readOnlyHint: true` and `openWorldHint: true`. The workflow's write-tool approval does not ask before them.
- **Destinations.** Each call is judged against the provider's real host, so data destination rules and Guard destination checks see `en.wikipedia.org`, `serpapi.com` or your SearXNG host.
- **Outbound policy.** Requests go through the API's outbound URL guard: with `OUTBOUND_DENY_PRIVATE=true`, a SearXNG instance on a private address is refused unless `OUTBOUND_ALLOWLIST` names it. Redirects are checked hop by hop.
- **Keys.** The key is read from the secret when the call is made, after the checks above, and added to the request by the server. It is never a tool argument, so the model, argument summaries, telemetry rows and recorded cassettes never see it; error messages that quote it are scrubbed.
- **Limits, telemetry, replay.** Calls count in MCP tool telemetry, and a recorded run replays them from its cassette without calling the provider.

Answers are trimmed (at most 20 results, long text cut) and responses over 2 MiB are refused.

Two Wikipedia nodes on one agent would expose the same tool names; use one per agent.

## Think tool

Turn on **Think Tool** on an Agent or Supervisor to give it a `think` tool: a scratchpad step for planning and for checking a tool result before acting on it. It is off by default.

- Calling it fetches nothing and changes nothing. The model gets a short acknowledgement.
- Each note appears in the node's activity and the run tape as **Thought: ...**, and on the step's tool results with a `thought` field.
- It is a runtime tool like `agent_clarify`: no tool rules, Guard checks or labels apply to it (the note is the model's own output, and the final answer is still guarded), it is not cached in the session tool cache, and it writes no MCP telemetry row.

## Related

- [Agent loop](./agent-loop.md)
- [Workflow Tool: call another workflow from an agent](./workflow-tool.md)
- [Govern MCP tools](../guides/govern-mcp-tools.md)
