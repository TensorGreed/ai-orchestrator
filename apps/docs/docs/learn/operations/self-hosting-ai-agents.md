---
title: "Self-hosted AI agent platform: what you run and why"
sidebarTitle: "Self-hosting AI agents"
description: "What a self-hosted agent platform runs (API, workers, database, models), the trade-offs against hosted tools, and a checklist for a first production setup."
level: intermediate
about: self-hosted
related: [self-hosted, master-key, sbom, mcp-server]
socialCard: true
---

# Self-hosting an AI agent platform

Self-hosting an AI agent platform means running its server, its database and its workers on infrastructure you control, so prompts, tool results, run history and credentials stay inside your network. The models can be local or remote: a self-hosted platform can still call a hosted model API, but you decide which one, with which key, and what is recorded. In exchange, you take on installing, upgrading, backing up and watching the platform yourself.

## Why teams self-host

Teams that self-host usually cite data and control:

- **Where data sits.** An agent run records the user's message, every tool call with its arguments, every tool result and the answer. On a <Term id="self-hosted">self-hosted</Term> platform that history sits in your database, under your retention and backup rules.
- **Network reach.** Agents are useful because they reach internal systems: a ticket database, an internal API, a code host on a private network. A platform inside the network can call them without opening inbound access from someone else's cloud.
- **Credentials.** The platform holds keys for those systems. Self-hosting keeps them in your secret store, encrypted with a key you hold.
- **Audit.** Security reviews ask who ran what, with which tool and which data. Logs and audit records on your own systems can be kept, exported and checked on your terms.
- **Model choice.** Some data may only go to a local model. A self-hosted platform can send those runs to a model server on your hardware and others to a hosted API.

Hosted workflow tools trade all of this for less operations work. If your agents only read public data and your team has no one to run a service, a hosted tool may be the better choice.

## What runs

A self-hosted agent platform is a handful of ordinary services:

<figure>
<svg viewBox="0 0 640 250" role="img" aria-labelledby="sh-fig-title sh-fig-desc" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:auto;max-width:640px">
  <title id="sh-fig-title">The parts of a self-hosted agent platform</title>
  <desc id="sh-fig-desc">Browsers and API callers reach a reverse proxy. Behind it, a web UI and API replicas. API replicas and workers share one database. Workers and API call model endpoints and MCP servers.</desc>
  <g font-family="inherit" font-size="13" fill="currentColor">
    <rect x="20" y="20" width="150" height="40" rx="8" fill="none" stroke="currentColor"/>
    <text x="95" y="45" text-anchor="middle">Users, webhooks</text>
    <rect x="20" y="105" width="150" height="40" rx="8" fill="none" stroke="currentColor"/>
    <text x="95" y="130" text-anchor="middle">Reverse proxy (TLS)</text>
    <rect x="240" y="20" width="160" height="40" rx="8" fill="none" stroke="currentColor"/>
    <text x="320" y="45" text-anchor="middle">Web UI</text>
    <rect x="240" y="105" width="160" height="40" rx="8" fill="none" stroke="var(--vp-c-brand-1, #3b82f6)" stroke-width="2"/>
    <text x="320" y="130" text-anchor="middle">API replicas</text>
    <rect x="240" y="190" width="160" height="40" rx="8" fill="none" stroke="var(--vp-c-brand-1, #3b82f6)" stroke-width="2"/>
    <text x="320" y="215" text-anchor="middle">Queue workers</text>
    <rect x="470" y="190" width="150" height="40" rx="8" fill="none" stroke="currentColor"/>
    <text x="545" y="215" text-anchor="middle">Database</text>
    <rect x="470" y="105" width="150" height="40" rx="8" fill="none" stroke="currentColor"/>
    <text x="545" y="125" text-anchor="middle">Models and</text>
    <text x="545" y="140" text-anchor="middle">MCP servers</text>
    <path d="M95 60 L95 105" stroke="currentColor"/>
    <path d="M170 118 L240 45" stroke="currentColor"/>
    <path d="M170 125 L240 125" stroke="currentColor"/>
    <path d="M400 125 L470 125" stroke="currentColor"/>
    <path d="M400 210 L470 210" stroke="currentColor"/>
    <path d="M400 135 L470 200" stroke="currentColor"/>
    <path d="M400 200 L470 135" stroke="currentColor"/>
  </g>
</svg>
<figcaption>One database holds the state; API replicas and workers can be added beside it.</figcaption>
</figure>

- **The API server.** It holds the workflow definitions, starts runs, runs the <Term id="agent-loop">agent loop</Term>, calls models and tools, and serves webhooks.
- **The web UI.** The editor and admin screens, usually static files behind the same proxy.
- **The database.** Users, workflows, run history, encrypted secrets, audit records. Everything stateful lives here.
- **Workers.** Processes that take queued runs, so long agent runs do not tie up the processes answering HTTP.
- **Model endpoints.** A hosted model API, a local model server, or both.
- **<Term id="mcp-server">MCP servers</Term>.** The tools: remote servers over HTTP, or local programs the platform starts over stdio.
- **A reverse proxy** for TLS, and optionally a load balancer when there is more than one API process.

## Start small: one process, one file

The first install can be a single process with an embedded database file. That is enough for a team trying agents out, and it has fewer parts to break. Move to a database server when you need any of these:

- more than one API process (an embedded database file has one writer);
- managed backups, replication or point-in-time recovery;
- a database your operations team already monitors.

Plan the move early. Copying data between databases is easier while there is little of it.

## Scaling out

When one process is not enough, scale the two kinds of load separately:

- **Request traffic** (the UI, webhooks, gateway calls): add API replicas behind a load balancer, with a readiness check so a draining replica stops getting traffic.
- **Run volume** (agents mostly wait on models and tools): add workers that take runs from a queue in the database.

Watch for state that lives in one process's memory. Anything a second replica cannot see, such as a long-lived protocol session, needs sticky routing or a shared store.

## Backups and the master key

A self-hosted platform encrypts stored secrets with a key you supply. That key is now the most important thing you hold:

- A database backup without its key restores without the secrets. Keep the key for as long as you keep backups made with it.
- Someone with both the backup and the key can read every stored secret. Store the <Term id="master-key">master key</Term> apart from the backups, with its own access control.
- Test a restore into a fresh instance before you need one. A backup that was never restored is a hope, not a plan.
- Retention and deletion do not reach backups already taken. Rotate backups within the retention you promise.

## Verify what you install

A platform that holds your credentials is worth checking before you run it:

- **Pin images by digest**, not by a moving tag, so the image you tested is the image you deploy.
- **Check the signature and build provenance**: who built the image, from which commit, in which build system.
- **Read the <Term id="sbom">SBOM</Term>** (software bill of materials) for the packages inside, and scan it with the tools you already use.
- **Check what it calls out to.** Know which outbound connections the platform makes on its own, and block the rest at the network.

## What you take on

Self-hosting moves work to your team:

- **Upgrades.** Read release notes, test upgrades with a copy of production data, and keep a rollback path.
- **On-call.** Someone has to notice when runs fail, the queue backs up or the database fills.
- **Security patches** for the platform, its base images and the database.
- **Capacity.** Disk for run history, memory for agents in flight, database connections for every replica.
- **Your own controls.** Sign-in, roles, network rules and retention are yours to set. The NIST Generative AI Profile is a useful checklist of risks to cover.

## A first production checklist

1. Generate the master key, store it in your secret manager, and keep a copy apart from backups.
2. Bind the API to localhost or a private network, and expose it only through a TLS proxy.
3. Turn off public sign-up; create the first admin from configuration.
4. Choose the database: the embedded file for one process, a database server for more.
5. Schedule backups and run one restore drill.
6. Pin image digests and verify signatures.
7. Send logs and metrics to the systems you already watch.
8. Set retention for run history and agent memory to what your policy allows.
9. Set a deployment budget and an iteration limit on every agent.
10. Write down who upgrades it and who answers alerts.

## In L2M

[L2M](/why) is open source (MIT) and runs only on your infrastructure: there is no hosted edition, and the product sends no analytics. Two things do load from the internet by default: the studio's web fonts (Google Fonts) and the API reference page at `/api/docs` (Swagger UI from a public CDN). Know both before you lock down outbound traffic. Beyond the defaults, everything below is optional.

- **Install.** Run from source with Node.js and pnpm ([Quickstart](/getting-started/quickstart)), with the Docker Compose files in the repository, or with the Helm chart in `ops/helm`. The API and web images are published to GHCR for `linux/amd64` and `linux/arm64`.
- **Database.** SQLite by default with nothing to configure; [Postgres](/operations/postgres) with `DB_TYPE=postgres`, and `db:copy` to move data across.
- **Scaling.** In [cluster mode](/operations/cluster) (`DB_TYPE=postgres` and `HA_ENABLED=true`), several API instances and separate [queue workers](/operations/queue-and-workers) share one Postgres, with one leader for schedules and purges. On SQLite, one process is its own worker. [Scaling](/operations/scaling) covers roles, sizing and a load test harness. MCP gateway sessions are the one piece that needs sticky routing; the cluster page shows how to route them.
- **Backups.** [Backup and recovery](/operations/backup-and-recovery) has procedures for SQLite, Postgres and a portable export, a restore drill, and what to do after losing the master key (`SECRET_MASTER_KEY_BASE64`).
- **Verification.** Each release image is signed with keyless cosign and carries SLSA build provenance and CycloneDX SBOMs: [Verify a release](/operations/verify-a-release).
- **Observability.** Structured logs, Prometheus metrics at `/metrics`, and optional OTLP export of traces and metrics: [Observability](/operations/observability).

## Try it in L2M

Follow the [Quickstart](/getting-started/quickstart) to run L2M on your laptop with SQLite, then import the [zero-key MCP agent recipe](/recipes/zero-key-mcp-agent): it runs with no API key. Before your first shared install, work through [Backup and recovery](/operations/backup-and-recovery) and [Verify a release](/operations/verify-a-release).

## Further reading

- [NIST AI 600-1: Generative Artificial Intelligence Profile](https://www.nist.gov/publications/artificial-intelligence-risk-management-framework-generative-artificial-intelligence) (nist.gov, July 2024): a voluntary companion to the AI Risk Management Framework
- [MCP Security Best Practices](https://modelcontextprotocol.io/docs/2025-11-25/tutorials/security/security_best_practices) (modelcontextprotocol.io): local MCP server compromise and sandboxing
- L2M docs: [Postgres](/operations/postgres), [Scaling](/operations/scaling), [Backup and recovery](/operations/backup-and-recovery), [Verify a release](/operations/verify-a-release)
