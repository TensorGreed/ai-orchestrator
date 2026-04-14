# n8n Feature Parity Roadmap

> Reference document for achieving feature parity with n8n. Use this in implementation prompts.
> Generated: 2026-04-13 | Baseline: ai-orchestrator current main branch

---

## Gap Analysis Summary

| Area | n8n | ai-orchestrator | Parity % |
|---|---|---|---|
| Integrations/Connectors | 400+ built-in | 7 legacy + 11 Tier 1 (HTTP, Slack, SMTP/IMAP, Google Sheets, Postgres, MySQL, MongoDB, Redis, GitHub) | ~15% |
| Trigger Types | 15 core + 90 app-specific | webhook, schedule, slack, github, imap, google_sheets, postgres, redis, error, sub_workflow, manual, form, chat, file, rss, sse, mcp_server, kafka/rabbitmq/mqtt (stubs) (19) | ~19% |
| Workflow Engine | Full (sub-workflows, parallel, queue) | Sub-workflows, queue, flow control, per-node error settings, error workflows | ~65% |
| Data Transformation | 25+ dedicated nodes | 23 (5 base + 18 Phase 2 transformation nodes) | ~80% |
| Code/Scripting | JS + Python + expressions | JS + Python code node, JS expression engine ($jmespath, $if, $ifEmpty, built-ins) | ~60% |
| Error Handling | Error workflows, retry, continue-on-fail | Try/catch, error categories | ~35% |
| Execution History | Full with debug/replay/pin | Basic history table | ~25% |
| Version Control | Git integration, workflow history | None | 0% |
| User Management | RBAC, projects, SAML, LDAP | RBAC (4 roles), session auth | ~30% |
| AI/LLM Features | LangChain, 15+ models, 12 vector stores | Agent loop, 6 providers, 5 vector stores | ~50% |
| Self-Hosting/Scaling | Queue mode, workers, PostgreSQL, K8s | SQLite + PostgreSQL, in-process queue, concurrency control | ~35% |
| Community/Marketplace | 5800+ community nodes, 9100+ templates | 8 sample workflows | ~1% |
| API | Full REST API (OpenAPI 3.0) | Partial REST API | ~40% |
| UI Features | Mini-map, sticky notes, tags, folders, dark mode, undo/redo | Mini-map + Controls, multi-select, copy/paste/duplicate, undo/redo, sticky notes (markdown), node color coding, disable toggle, shortcuts panel, dark mode; structured config editors for all Phase 1 + 2 nodes | ~70% |
| Testing/Debug | Pin data, debug executions, single-node run | Manual execute only | ~10% |
| Notifications/Alerting | Error workflow pattern | None | 0% |
| Logging/Observability | Log streaming (Syslog, Webhook, Sentry), audit | Basic execution logs | ~10% |
| Variables/Environments | Global + project vars, 200+ env config | Workflow variables only | ~20% |
| Enterprise Features | SSO, LDAP, audit logs, external secrets, HA | Basic auth + encrypted secrets | ~15% |

---

## Phase 1: Core Engine Parity (Sprints 1-3)

### 1.1 Sub-Workflow Execution
**n8n equivalent:** Execute Workflow node + Execute Sub-workflow Trigger
- [x] `execute_workflow` node that calls another workflow by ID
- [x] `sub_workflow_trigger` node for child workflows
- [x] Sync mode (wait for result) and async (fire-and-forget)
- [x] Parent-child execution relationship tracking
- [x] Recursion depth limit (`MAX_SUB_WORKFLOW_DEPTH = 10`)

### 1.2 Enhanced Flow Control Nodes
**n8n equivalent:** Filter, Stop And Error, No Operation, Wait (webhook resume)
- [x] `filter_node` — pass/reject items based on conditions (13 operators, AND/OR, passMode)
- [x] `stop_and_error` — halt execution with custom error + errorCode
- [x] `noop_node` — pass-through for routing clarity
- [x] `wait_node` enhancement — datetime resume mode added (alongside timer)

### 1.3 Node-Level Error Settings
**n8n equivalent:** Continue on Fail, Retry on Fail (per-node)
- [x] Per-node `continueOnFail` setting — workflow continues, error passed downstream
- [x] Per-node `retryOnFail` — max retries + wait interval (ms), configurable in node settings
- [x] `alwaysOutputData` — node returns output even with no input
- [x] Dedicated error output branch on supported nodes (`onError: "branch"`)

### 1.4 Error Workflows
**n8n equivalent:** Error Workflow system + Error Trigger node
- [x] `error_trigger` node type — fires when any designated workflow fails
- [x] Workflow settings: designate an "Error Workflow" via `workflow.settings.errorWorkflowId`
- [x] Error payload: execution ID, workflow name, error message, stack trace, timestamp
- [x] One error workflow can serve multiple production workflows

### 1.5 Execution Queue & Worker Architecture
**n8n equivalent:** Queue mode with Redis (BullMQ) + worker processes
- [x] Job queue backend (SQLite-persisted in-process queue, Redis/BullMQ-ready interface)
- [x] Main process: handle triggers, enqueue execution jobs via `POST /api/workflows/:id/enqueue`
- [x] Worker processes: `QueueService` dequeues and executes jobs with concurrency control
- [x] Configurable concurrency control (`QUEUE_CONCURRENCY` env var, default 5)
- [ ] Horizontal scaling — add/remove workers dynamically (requires Redis/BullMQ migration)
- [x] Dead letter queue for permanently failed executions (DLQ with exponential backoff)

### 1.6 Database Upgrade Path
**n8n equivalent:** PostgreSQL for production
- [x] PostgreSQL adapter alongside SQLite (`PostgresStore` with full method parity)
- [x] Database migration system (versioned migrations via `migrations.ts`)
- [x] Connection pooling (`pg.Pool` with configurable max connections)
- [x] Configuration via env vars (`DB_TYPE`, `DB_POSTGRESDB_HOST/PORT/DATABASE/USER/PASSWORD/SSL/POOL_SIZE`)

---

## Phase 2: Data Transformation & Expression Engine (Sprints 4-5)

### 2.1 Dedicated Data Transformation Nodes
**n8n equivalent:** 25+ transformation nodes
- [x] `aggregate_node` — group items (sum, avg, min, max, count, concatenate)
- [x] `split_out_node` — unpack array field into separate items
- [x] `sort_node` — ascending, descending, random, custom expression
- [x] `limit_node` — cap output to N items
- [x] `remove_duplicates_node` — deduplicate by all or specific fields
- [x] `summarize_node` — aggregate operations across items
- [x] `compare_datasets_node` — diff two datasets
- [x] `rename_keys_node` — rename JSON keys
- [x] `edit_fields_node` — enhance existing `set_node` (add, modify, remove, rename)
- [x] `date_time_node` — format, parse, add/subtract, compare dates
- [x] `crypto_node` — hash, HMAC, encrypt, decrypt, sign, verify
- [x] `jwt_node` — sign, decode, verify JWTs (HS256/HS384/HS512, hand-rolled)
- [x] `xml_node` — parse XML to JSON, JSON to XML (hand-rolled lightweight parser)
- [x] `html_node` — extract data via CSS selectors, generate HTML (minimal selector engine)
- [x] `convert_to_file_node` — data to CSV, JSON, HTML, text (Excel deferred — needs optional dep)
- [x] `extract_from_file_node` — parse CSV, JSON, XML (PDF/Excel emit clear NOT_IMPLEMENTED error — optional deps required)
- [x] `compression_node` — gzip/gunzip via node:zlib (zip/unzip emit NOT_IMPLEMENTED — needs optional dep)
- [x] `edit_image_node` — registered + graceful NOT_IMPLEMENTED (image editing requires optional native dep, e.g. sharp/jimp)

### 2.2 Expression Engine Enhancement
**n8n equivalent:** JS expressions with built-in variables and methods
- [x] Replace Handlebars with JS-based expression engine (`packages/workflow-engine/src/expression.ts`)
- [x] Built-in variables: `$input`, `$json`, `$node`, `$workflow`, `$execution`, `$env`, `$vars`, `$now`, `$today`, `$itemIndex`
- [x] Built-in methods: JS-native string/number/date/array/object access via sandboxed `with` scope
- [x] `$jmespath()` support for complex JSON querying (dot paths, `[index]`, `[*]`, `[?field=='x']`)
- [x] `$if()`, `$ifEmpty()` inline conditionals
- [ ] Expression editor with autocomplete and syntax highlighting in UI (deferred to Phase 4 — UI work)

### 2.3 Python Support in Code Node
**n8n equivalent:** Code node with JS + Python
- [x] Python runtime in code node (subprocess via `child_process.spawn`, graceful CONFIGURATION error if `python3`/`python` is missing)
- [x] "Run Once for All Items" vs "Run Once for Each Item" modes (both JS and Python)
- [x] Access to incoming item data (`items` / `item` variables in user code)
- [ ] Configurable external module allowlist (deferred — current build relies on Python's import system)

---

## Phase 3: Integrations & Connectors (Sprints 6-9)

### 3.1 Priority Tier 1 — Essential (Sprint 6)
**Must-have for MVP parity. Each needs: trigger node + action node + credential type.**

| Integration | n8n nodes | Priority | Status |
|---|---|---|---|
| **HTTP Request** (universal) | GET/POST/PUT/DELETE, auth, pagination, binary | P0 | [x] existing, enhanced |
| **Slack** | Send message, update, triggers, channels, files | P0 | [x] `slack_send_message` + `slack_trigger` (webhook w/ signing-secret validation) |
| **Gmail / Email (SMTP)** | Send, read, triggers, labels | P0 | [x] `smtp_send_email` (nodemailer) |
| **Gmail / Email (IMAP trigger)** | — | P0 | [x] `imap_email_trigger` registered (NOT_IMPLEMENTED until `imapflow` installed) |
| **Google Sheets** | Read, append, update, triggers | P0 | [x] `google_sheets_read`/`_append`/`_update`/`_trigger` |
| **PostgreSQL** | Query, insert, update, triggers (listen) | P0 | [x] `postgres_query` + `postgres_trigger` (polling SELECT) |
| **MySQL** | Query, insert, update | P0 | [x] `mysql_query` (mysql2) |
| **MongoDB** | Find, insert, update, aggregate | P0 | [x] `mongo_operation` (all four ops) |
| **Redis** | Get, set, publish, subscribe trigger | P0 | [x] `redis_command` + `redis_trigger` (BLPOP polling; subscribe NOT_IMPLEMENTED at executor layer) |
| **GitHub** | Issues, PRs, commits, triggers | P0 | [x] `github_action` (8 ops) + `github_webhook_trigger` (X-Hub-Signature-256) |
| **HTTP/Webhook** | Already exists — enhance with response modes | P0 | [x] responseMode (onReceived/lastNode/responseNode) + responseCode/responseHeaders/responseBody |

### 3.2 Priority Tier 2 — High Value (Sprint 7)
| Integration | Category |
|---|---|
| **Microsoft Teams** | Communication |
| **Notion** | Productivity |
| **Airtable** | Productivity/Database |
| **Jira** | Project Management |
| **Salesforce** | CRM |
| **HubSpot** | CRM/Marketing |
| **Stripe** | Payments |
| **AWS S3** | Cloud Storage |
| **Telegram** | Communication |
| **Discord** | Communication |
| **Google Drive** | Already exists — enhance with triggers |
| **Google Calendar** | Productivity |
| **Twilio** | SMS/Voice |

### 3.3 Priority Tier 3 — Ecosystem Expansion (Sprints 8-9)
| Category | Integrations |
|---|---|
| **Marketing** | Mailchimp, SendGrid, ActiveCampaign, ConvertKit |
| **E-Commerce** | Shopify, WooCommerce, PayPal |
| **DevTools** | GitLab, Bitbucket, Sentry, Linear, Jenkins |
| **Analytics** | Google Analytics, Segment, Mixpanel |
| **Databases** | Snowflake, Elasticsearch, InfluxDB, Supabase |
| **Message Queues** | Kafka, RabbitMQ, AMQP, MQTT |
| **HR/Scheduling** | Calendly, BambooHR, Cal.com |
| **Forms** | Typeform, JotForm, Google Forms |
| **Security** | VirusTotal, CrowdStrike, TheHive |
| **File/Doc** | Microsoft Excel, Dropbox, Box, OneDrive |

### 3.4 Connector SDK V2 — Community Node System
**n8n equivalent:** npm-based community nodes (5800+)
- [ ] Standardized node package format (`l2m-nodes-*` npm packages)
- [ ] Node package manifest (name, version, description, node types, credentials)
- [ ] Install community nodes from UI (Settings > Community Nodes)
- [ ] Node discovery registry / marketplace
- [ ] Node sandboxing for untrusted packages
- [ ] Hot-reload on install (no restart required)

### 3.5 Trigger System Expansion
**n8n equivalent:** 15 core triggers + 90 app-specific
- [x] `manual_trigger` — `POST /api/triggers/manual/:workflowId` (builder role) with testData + payload merge
- [x] `error_trigger` — fires on workflow failure (see Phase 1.4)
- [x] `form_trigger` — HTML form rendered at `GET /api/forms/:path`, submitted via `POST /api/forms/:path` (public or session auth)
- [x] `chat_trigger` — `POST /api/chat/:workflowId` with public/session/bearer auth; auto-generates session_id
- [x] `file_trigger` — filesystem polling with glob pattern, recursive option, created/modified/deleted events; persists snapshot state
- [x] `rss_trigger` — RSS/Atom polling with GUID dedupe across 500-item window; hand-rolled XML parser (no extra dep)
- [x] `sse_trigger` — long-lived SSE consumer with auto-reconnect + bearer auth + event-name filter + rate limiting
- [x] `mcp_server_trigger` — exposes workflow as MCP tool at `POST /api/mcp-server/:path/invoke` with manifest at `GET /api/mcp-server/:path/manifest`
- [x] Polling trigger framework — `TriggerService` scans workflows, registers managed triggers, persists state to `trigger_state` table (version 3 migration); lifecycle hooks wired on workflow save/update/delete/duplicate/import
- [x] Message queue triggers — `kafka_trigger` / `rabbitmq_trigger` / `mqtt_trigger` with optional-dep detection (kafkajs / amqplib / mqtt); graceful NOT_IMPLEMENTED when deps absent, long-lived consumer is a stub pending dep install

---

## Phase 4: UI & Editor Parity (Sprints 10-11)

### 4.1 Canvas Enhancements
- [x] Mini-map for navigating large workflows (React Flow `<MiniMap>` with color-coded node dots)
- [x] Multi-select nodes (shift+click + shift+drag selection box via `selectionKeyCode` / `multiSelectionKeyCode`)
- [x] Copy/paste/duplicate nodes (Ctrl/⌘+C, Ctrl/⌘+V, Ctrl/⌘+D — duplicate preserves edges between selected nodes)
- [x] Undo/redo (Ctrl/⌘+Z and Ctrl/⌘+Shift+Z / Ctrl/⌘+Y) with 50-step history stack snapshotted on add/delete/paste/duplicate/config-change
- [x] Sticky notes with markdown rendering (headings, bold, italic, code, lists, links) and 6 color themes (yellow/blue/green/pink/purple/gray); executor treats as visual-only pass-through
- [x] Node color coding (8 accent colors) with left-border stripe on canvas + matching minimap dot
- [x] Node disable/enable toggle (`disabled` field on `WorkflowNode`, Settings tab + `E` hotkey; executor skips disabled nodes and passes parent outputs downstream)
- [x] Keyboard shortcuts reference panel (open via `?` or Ctrl/⌘+/ or header button)
- [x] Dark mode via `data-theme` attribute on `<html>` + CSS variable swap; toggle in header + respects `prefers-color-scheme`; persists to localStorage

### 4.2 Workflow Organization
- [ ] Tags — categorize and filter workflows
- [ ] Folders — organize workflows in hierarchy
- [ ] Projects — isolated workspaces (workflows + credentials + variables)
- [ ] Workflow search by name, tag, content
- [ ] Workflow duplication (already exists — verify parity)

### 4.3 Testing & Debug Tools
**n8n equivalent:** Pin data, debug executions, single-node run
- [ ] **Data pinning** — save node output, reuse in test runs without calling external services
- [ ] **Execute single node** — run one node using previous output or pinned data
- [ ] **Debug past executions** — load failed execution data into editor, re-run
- [ ] **Execution preview** — see input/output at each node inline on canvas
- [ ] **Schema view** — show data structure at each node
- [ ] **Table view** — tabular data inspection
- [ ] Expression editor with autocomplete and preview

### 4.4 Execution History Enhancements
- [ ] Filter by status, workflow, date range
- [ ] Custom execution metadata (`$execution.customData`)
- [ ] Manual retry of failed executions from history
- [ ] Execution data retention configuration (max age, pruning)
- [ ] Cancel running executions

---

## Phase 5: Enterprise & Operations (Sprints 12-14)

### 5.1 Authentication Enhancements
- [ ] SAML 2.0 SSO (Okta, Azure AD, OneLogin)
- [ ] LDAP / Active Directory integration
- [ ] MFA / 2FA with enforcement option
- [ ] User provisioning via SSO (group-based role mapping)
- [ ] API key authentication (for programmatic access)

### 5.2 Advanced RBAC & Multi-Tenancy
- [ ] Project-level roles (Admin, Editor, Viewer)
- [ ] Custom roles with granular permissions (Enterprise)
- [ ] Credential sharing scoped to projects
- [ ] Cross-project workflow sharing controls

### 5.3 External Secrets
**n8n equivalent:** AWS Secrets Manager, HashiCorp Vault, Google Secret Manager
- [ ] External secrets provider interface
- [ ] AWS Secrets Manager adapter
- [ ] HashiCorp Vault adapter
- [ ] Google Secret Manager adapter
- [ ] Azure Key Vault adapter (extending existing Azure ecosystem)
- [ ] Automatic rotation — updated secrets used without workflow changes

### 5.4 Audit Logging
- [ ] Comprehensive audit trail: user auth, credential CRUD, workflow CRUD, execution events
- [ ] Configurable retention (default 12 months)
- [ ] Audit report generation via API

### 5.5 Log Streaming
**n8n equivalent:** Syslog, Webhook, Sentry destinations
- [ ] Log streaming framework with pluggable destinations
- [ ] Syslog destination
- [ ] Webhook destination (custom headers)
- [ ] Sentry destination
- [ ] Event categories: workflow, node, audit, worker, AI, queue events
- [ ] Configure from Settings UI

### 5.6 Version Control & Environments
**n8n equivalent:** Git-based source control with branch-per-environment
- [ ] Connect instance to Git repository
- [ ] Push/pull workflows from UI
- [ ] Branch-per-environment (dev, staging, prod)
- [ ] Workflow history with restore (built-in versioning)
- [ ] Credential stubs in export (not secrets)
- [ ] Variables included in source control

### 5.7 Observability & Metrics
- [ ] Prometheus metrics endpoint (`/metrics`)
- [ ] Grafana dashboard templates
- [ ] Distributed tracing (OpenTelemetry)
- [ ] Health check endpoint
- [ ] SLO tracking (execution success rate, p95 latency)

---

## Phase 6: AI Feature Expansion (Sprints 15-16)

> ai-orchestrator already leads in some AI areas (MCP, Swarm). Focus on closing remaining gaps.

### 6.1 Additional AI Agent Types
**n8n equivalent:** Conversational, OpenAI Functions, Plan-and-Execute, ReAct, SQL, Tools agents
- [ ] Plan-and-Execute agent type
- [ ] ReAct agent type
- [ ] SQL Agent (natural language to SQL)
- [ ] Agent type selection in agent_orchestrator config

### 6.2 LangChain-Style Chains
**n8n equivalent:** Basic LLM Chain, QA Chain, Summarization Chain, extractors, classifiers
- [ ] `basic_llm_chain` — simple prompt → response
- [ ] `qa_chain` — RAG question answering (enhance existing rag_retrieve)
- [ ] `summarization_chain` — document summarization
- [ ] `information_extractor` — structured extraction from text
- [ ] `text_classifier` — classify text into categories
- [ ] `sentiment_analysis` — sentiment scoring

### 6.3 Additional AI Infrastructure
- [ ] Additional embedding adapters: AWS Bedrock, Cohere, Google Vertex, Mistral, HuggingFace
- [ ] Additional vector stores: Chroma, Weaviate, Supabase, MongoDB Atlas, Milvus, Redis, Zep
- [ ] Additional memory backends: MongoDB, PostgreSQL, Redis, Zep
- [ ] Text splitters: Character, Recursive Character, Token
- [ ] Retrievers: Contextual Compression, MultiQuery, Workflow Retriever
- [ ] AI evaluation framework (test/evaluate agent performance)
- [ ] AI Transform node (natural language to code)
- [ ] Guardrails node enhancement (validate AI outputs against schemas)

### 6.4 AI Tools Expansion
- [ ] Wikipedia tool
- [ ] Web search tool (SerpAPI / SearXNG)
- [ ] Wolfram Alpha tool
- [ ] Think tool (agent reasoning step)
- [ ] Workflow-as-tool (call another workflow as an agent tool)
- [ ] Agent-as-tool (call another agent as a tool)

---

## Phase 7: Scaling & Production Hardening (Sprints 17-18)

### 7.1 Deployment & Infrastructure
- [ ] Kubernetes Helm chart
- [ ] Docker Compose production template (API + Web + PostgreSQL + Redis)
- [ ] AWS ECS Fargate deployment guide
- [ ] Multi-main high availability (leader election)
- [ ] Webhook-specific process separation

### 7.2 Performance
- [ ] Parallel node execution within workflows (independent branches)
- [ ] Execution data pruning (configurable retention)
- [ ] Large workflow optimization (1000+ nodes)
- [ ] Binary data handling (file passthrough between nodes)
- [ ] Streaming execution for large datasets (item-level processing)

### 7.3 API Completeness
**n8n equivalent:** Full OpenAPI 3.0 REST API
- [ ] OpenAPI 3.0 spec generation
- [ ] API key authentication
- [ ] Workflow activate/deactivate endpoints
- [ ] Workflow transfer between projects
- [ ] Execution stop/cancel endpoint
- [ ] Credential schema endpoint
- [ ] User invite/management endpoints
- [ ] Project CRUD endpoints
- [ ] Tag CRUD endpoints
- [ ] Variable CRUD endpoints
- [ ] Source control push/pull endpoints
- [ ] Audit report endpoint
- [ ] Pagination on all list endpoints

### 7.4 Workflow Templates & Sharing
- [ ] Template library with categories
- [ ] One-click import from template gallery
- [ ] Workflow export/share via URL
- [ ] Community template submissions
- [ ] Template search and filtering

### 7.5 Notifications
- [ ] Error notification framework (via error workflows)
- [ ] Built-in email notification on workflow failure
- [ ] Slack/Teams webhook notification presets
- [ ] Notification preferences in Settings UI

---

## Implementation Priority Matrix

| Priority | Phase | Estimated Effort | Business Impact |
|---|---|---|---|
| **P0 — Critical** | Phase 1 (Engine) | 6 sprints | Unblocks all other work |
| **P0 — Critical** | Phase 3.1 (Tier 1 Connectors) | 2 sprints | Users can't adopt without integrations |
| **P1 — High** | Phase 2 (Data Transform) | 4 sprints | Core workflow authoring |
| **P1 — High** | Phase 4 (UI) | 4 sprints | User experience parity |
| **P1 — High** | Phase 5.1-5.4 (Enterprise Auth) | 3 sprints | Enterprise adoption |
| **P2 — Medium** | Phase 3.2-3.3 (Tier 2-3 Connectors) | 4 sprints | Ecosystem breadth |
| **P2 — Medium** | Phase 5.5-5.7 (Observability) | 3 sprints | Operations readiness |
| **P2 — Medium** | Phase 7 (Scaling) | 4 sprints | Production scale |
| **P3 — Lower** | Phase 6 (AI Expansion) | 4 sprints | Already ahead of n8n here |
| **P3 — Lower** | Phase 3.4 (Community Nodes) | 2 sprints | Ecosystem growth |

---

## What ai-orchestrator Already Does Better Than n8n

These are areas where the current codebase is **ahead** — protect and build on these:

1. **MCP Integration** — First-class Model Context Protocol support with tool discovery; n8n only has basic MCP Client Tool
2. **Multi-Agent Swarm** — Supervisor + Worker agent delegation with recursive nesting; n8n has no equivalent
3. **Structured Error Categories** — 15 typed error categories with retryability metadata; n8n uses generic errors
4. **Agent Tool Output Controls** — Configurable truncation, depth limits, key limits for tool payloads; n8n lacks this
5. **Session Tool Cache** — Automatic caching of tool results across multi-turn sessions; unique feature
6. **Webhook Security** — HMAC-SHA256 signing + replay protection + idempotency built-in; n8n webhook auth is simpler
7. **Output Parser Strictness** — Three parsing modes (strict/lenient/anything_goes); more flexible than n8n

---

## How to Use This Roadmap

In implementation prompts, reference specific sections:

```
Implement Phase 1.1 (Sub-Workflow Execution) from N8N_PARITY_ROADMAP.md
```

```
Implement Phase 3.1 Slack integration from N8N_PARITY_ROADMAP.md
```

Check off items as completed. Update parity percentages in the summary table after each phase.
