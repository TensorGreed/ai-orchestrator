# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Use [GitHub's private vulnerability reporting](https://github.com/TensorGreed/ai-orchestrator/security/advisories/new) to report security issues confidentially. The maintainers will:

1. Acknowledge receipt within **72 hours**.
2. Triage the report, assess severity (CVSS), and confirm or dispute the finding within **7 days**.
3. Develop a fix in a private branch.
4. Coordinate a release and a public advisory once the fix lands. We aim for a **30-day** maximum from confirmed report to public advisory; severe issues may move faster.

If you don't receive an acknowledgement within 72 hours, please follow up — please don't disclose publicly while the report is in flight unless we've gone silent for an extended period.

## Scope

In scope:

- The L2M API server (`apps/api`) — Fastify routes, auth, RBAC, secret handling, webhook signature validation, leader election, MCP integration.
- The Studio web UI (`apps/web`) — XSS, CSRF, IDOR, leakage of sensitive fields.
- The agent runtime (`packages/agent-runtime`) — prompt-injection-driven privilege escalation, tool sandboxing.
- The MCP SDK (`packages/mcp-sdk`) — adapter behavior, especially the `stdio` transport which spawns child processes.
- The connector SDKs — credential handling, SSRF, request smuggling.
- The Helm chart and Docker images (`ops/helm/`, `apps/api/Dockerfile`, `apps/web/Dockerfile`).
- The VS Code extension (`apps/vscode-l2m-agent`) — workspace path-safety, command-execution gating.

Out of scope:

- Vulnerabilities in third-party dependencies (report to the upstream project; we'll backport fixes through dependency bumps).
- Findings that require local code execution on a developer's machine to exploit (e.g. malicious workflows imported from untrusted sources without warning).
- Denial-of-service via resource exhaustion when an admin has explicitly disabled rate limiting / body-size limits.
- Self-XSS that requires the victim to paste attacker-controlled content into their own DevTools.

## Supported versions

We maintain security fixes for the **latest released minor version** on `main`. Older versions are unsupported — backporting will be considered case-by-case for critical issues affecting deployed users.

## Recognition

We're a small project and don't run a paid bounty program, but security-relevant fixes are credited in the release notes and on the GitHub Security Advisory unless the reporter prefers anonymity.
