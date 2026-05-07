<!--
  Generated from packages/shared/src/definitions.ts.
  DO NOT EDIT BY HAND — run `pnpm --filter @ai-orchestrator/docs gen:nodes`
  (or `pnpm docs:build`) to regenerate.
-->

# Agent nodes

Tool-calling agent runtimes and the multi-turn memory + artifact stores that back them.

2 nodes.

---
### `agent_orchestrator` — Agent Orchestrator

Runs iterative tool-aware agent loop.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `agentType` | `string` | no | `tools` \| `react` \| `plan-and-execute` \| `sql` |
| `systemPromptTemplate` | `string` | no | — |
| `userPromptTemplate` | `string` | no | — |
| `sessionIdTemplate` | `string` | no | — |
| `maxIterations` | `number` | yes | — |
| `toolCallingEnabled` | `boolean` | no | — |
| `toolMessageMaxChars` | `number` | no | — |
| `toolPayloadMaxDepth` | `number` | no | — |
| `toolPayloadMaxObjectKeys` | `number` | no | — |
| `toolPayloadMaxArrayItems` | `number` | no | — |
| `toolPayloadMaxStringChars` | `number` | no | — |

**Example config**

```json
{
  "agentType": "tools",
  "systemPromptTemplate": "{{system_prompt}}",
  "userPromptTemplate": "{{user_prompt}}",
  "sessionIdTemplate": "{{session_id}}",
  "maxIterations": 6,
  "toolCallingEnabled": true,
  "toolMessageMaxChars": 6000,
  "toolPayloadMaxDepth": 4,
  "toolPayloadMaxObjectKeys": 32,
  "toolPayloadMaxArrayItems": 8,
  "toolPayloadMaxStringChars": 400
}
```

---

### `supervisor_node` — Supervisor Node

Swarm Supervisor that coordinates attached Worker nodes.

**Config fields**

| Field | Type | Required | Values |
|---|---|---|---|
| `systemPromptTemplate` | `string` | no | — |
| `userPromptTemplate` | `string` | no | — |
| `sessionIdTemplate` | `string` | no | — |
| `maxIterations` | `number` | yes | — |
| `toolMessageMaxChars` | `number` | no | — |
| `toolPayloadMaxDepth` | `number` | no | — |
| `toolPayloadMaxObjectKeys` | `number` | no | — |
| `toolPayloadMaxArrayItems` | `number` | no | — |
| `toolPayloadMaxStringChars` | `number` | no | — |

**Example config**

```json
{
  "systemPromptTemplate": "{{system_prompt}}",
  "userPromptTemplate": "{{user_prompt}}",
  "sessionIdTemplate": "{{session_id}}",
  "maxIterations": 10,
  "toolMessageMaxChars": 6000,
  "toolPayloadMaxDepth": 4,
  "toolPayloadMaxObjectKeys": 32,
  "toolPayloadMaxArrayItems": 8,
  "toolPayloadMaxStringChars": 400
}
```
