---
layout: home
hero:
  name: L2M
  text: The MCP-native agent runtime
  tagline: Visual workflow builder, multi-agent Swarm, and a VS Code surface — for developers composing AI agents that do real work in real systems via the Model Context Protocol.
  actions:
    - theme: brand
      text: Build your first MCP agent (5 min)
      link: /getting-started/build-your-first-mcp-agent
    - theme: alt
      text: Why L2M?
      link: /why
    - theme: alt
      text: GitHub
      link: https://github.com/TensorGreed/ai-orchestrator
features:
  - title: MCP-first
    details: Wire any Model Context Protocol server in as an agent tool. Schemas are compacted, tools are shortlisted by prompt relevance, and full outputs are cached across multi-turn sessions. Expose your own workflows back out as MCP tools that other agents invoke.
  - title: Multi-agent Swarm
    details: Compose Supervisor → Worker hierarchies via dedicated attachment ports. Workers become synthetic tools to the parent, recursively. Each worker brings its own model, tools and memory.
  - title: VS Code agent surface
    details: First-party extension turns any workflow into a coding agent inside the editor — streaming responses, patch previews with workspace-path safety, and command approval. Bring your own backend agent topology.
  - title: Production-ready foundations
    details: TOTP MFA and SSO through SAML or LDAP (optional packages). AES-256-GCM secrets with master-key rotation through db:export / db:import, and external secret managers (HashiCorp Vault built in; AWS, Google Cloud and Azure once their SDK is installed). RBAC with projects and custom roles, a tamper-evident audit log, Prometheus metrics and OpenTelemetry traces over OTLP.
---

## Documentation map

> **See it first:** the [live demo](https://lsquarem.com/demo/){target="_self"} is the real studio with recorded runs. It runs in your browser, with no sign-up.

- [Build your first MCP agent in 5 min](/getting-started/build-your-first-mcp-agent) — fastest end-to-end path
- [Pattern library](/patterns/) — 10 battle-tested topologies with runnable samples
- [Sample projects (l2m-samples)](https://github.com/TensorGreed/l2m-samples) — full reference implementations: helpdesk agent, support triage, VS Code repo reviewer
- [Why L2M?](/why) — the differentiators in detail
- [Quickstart](/getting-started/quickstart)
- [Workflow editor](/product/workflow-editor)
- [Agent loop](/runtime/agent-loop)
- [Architecture overview](/architecture/overview)
- [Core nodes](/nodes/core-nodes) · [Azure nodes](/nodes/azure-nodes) · [Vector stores](/nodes/vector-stores)
- [Auth & RBAC](/security/auth-rbac) · [Secrets](/security/secrets) · [Secure webhooks](/security/secure-webhooks)
- [API endpoints](/api/endpoints)
- [Extension SDKs](/extensions/providers) · [Connectors](/extensions/connectors) · [MCP](/extensions/mcp)
- [CI](/operations/ci) · [Testing & quality gates](/operations/testing-and-quality) · [Troubleshooting](/troubleshooting/common-issues)
