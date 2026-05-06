---
layout: home
hero:
  name: L2M
  text: The MCP-native agent runtime
  tagline: Visual workflow builder, multi-agent Swarm, and a VS Code surface — for developers composing AI agents that do real work in real systems via the Model Context Protocol.
  actions:
    - theme: brand
      text: Why L2M?
      link: /why
    - theme: alt
      text: 5-minute Quickstart
      link: /getting-started/quickstart
    - theme: alt
      text: GitHub
      link: https://github.com/TensorGreed/ai-orchestrator
features:
  - title: MCP-first
    details: Wire any Model Context Protocol server in as an agent tool. Schemas are compacted, tools are shortlisted by prompt relevance, and full outputs are cached across multi-turn sessions. Expose your own workflows back out as MCP tools that other agents invoke.
  - title: Multi-agent Swarm
    details: Compose Supervisor → Worker hierarchies via dedicated attachment ports. Workers become synthetic tools to the parent, recursively. Other visual workflow tools either lack MCP integration entirely or treat agent delegation as chained prompts rather than first-class topology.
  - title: VS Code agent surface
    details: First-party extension turns any workflow into a coding agent inside the editor — streaming responses, patch previews with workspace-path safety, and command approval. Bring your own backend agent topology.
  - title: Production-ready foundations
    details: SAML/LDAP SSO, MFA, encrypted secrets with rotation, external secret managers (Vault/AWS/GCP/Azure), RBAC + projects + custom roles, audit logs, Prometheus, OTEL tracing, and multi-main HA via leader election.
---

## Documentation map

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
