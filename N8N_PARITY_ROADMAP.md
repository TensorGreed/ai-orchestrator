# n8n Feature Parity Roadmap

> Reference document for achieving feature parity with n8n. Use this in implementation prompts.
> Generated: 2026-04-13 | Baseline: ai-orchestrator current main branch

---

## Gap Analysis Summary

| Area | n8n | ai-orchestrator | Parity % |
|---|---|---|---|
| Integrations/Connectors | 400+ built-in | 7 legacy + 11 Tier 1 + 13 Tier 2 (MS Teams, Notion, Airtable, Jira, Salesforce, HubSpot, Stripe, AWS S3, Telegram, Discord, Google Drive trigger, Google Calendar, Twilio) = 24 integrations / 50+ node types | ~25% |
| Trigger Types | 15 core + 90 app-specific | webhook, schedule, slack, github, imap, google_sheets, postgres, redis, error, sub_workflow, manual, form, chat, file, rss, sse, mcp_server, kafka/rabbitmq/mqtt (stubs) (19) | ~19% |
| Workflow Engine | Full (sub-workflows, parallel, queue) | Sub-workflows, queue, flow control, per-node error settings, error workflows | ~65% |
| Data Transformation | 25+ dedicated nodes | 23 (5 base + 18 Phase 2 transformation nodes) | ~80% |
| Code/Scripting | JS + Python + expressions | JS + Python code node, JS expression engine ($jmespath, $if, $ifEmpty, built-ins) | ~60% |
| Error Handling | Error workflows, retry, continue-on-fail | Try/catch, error categories | ~35% |
| Execution History | Full with debug/replay/pin | Basic history table | ~25% |
| Version Control | Git integration, workflow history | None | 0% |
| User Management | RBAC, projects, SAML, LDAP | Global RBAC (4 roles) + per-project RBAC (3 built-in + custom), session auth, API keys, MFA/TOTP, SAML + LDAP (optional-dep), SSO group-to-role mapping | ~75% |
| AI/LLM Features | LangChain, 15+ models, 12 vector stores | Agent loop, 6 providers, 5 vector stores | ~50% |
| Self-Hosting/Scaling | Queue mode, workers, PostgreSQL, K8s | SQLite + PostgreSQL, in-process queue, concurrency control | ~35% |
| Community/Marketplace | 5800+ community nodes, 9100+ templates | 8 sample workflows | ~1% |
| API | Full REST API (OpenAPI 3.0) | Partial REST API | ~40% |
| UI Features | Mini-map, sticky notes, tags, folders, dark mode, undo/redo | Mini-map + Controls, multi-select, copy/paste/duplicate, undo/redo, sticky notes (markdown), node color coding, disable toggle, shortcuts panel, dark mode, project switcher, folder sidebar, tag chips + filter; structured config editors for all Phase 1 + 2 nodes | ~80% |
| Testing/Debug | Pin data, debug executions, single-node run | Workflow-level pinned node data, single-node execution, failed-run debug load/re-run, inline execution preview, schema/table inspector, expression preview/autocomplete | ~70% |
| Notifications/Alerting | Error workflow pattern | None | 0% |
| Logging/Observability | Log streaming (Syslog, Webhook, Sentry), audit | Comprehensive audit log (auth/MFA/SSO/API keys/secrets/workflows/executions/RBAC/sharing) with filters + CSV export + configurable retention; execution logs; still missing log streaming destinations | ~45% |
| Variables/Environments | Global + project vars, 200+ env config | Workflow variables only | ~20% |
| Enterprise Features | SSO, LDAP, audit logs, external secrets, HA | SAML + LDAP SSO (optional-dep) with group-based provisioning, MFA/TOTP, API keys, encrypted secrets, workflow/secret sharing, external secret providers (AWS/Vault/GCP/Azure) with rotation cache, comprehensive audit log with CSV export. Still missing: HA | ~70% |

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
| Integration | Category | Status |
|---|---|---|
| **Microsoft Teams** | Communication | [x] `teams_send_message` (incoming webhook, MessageCard payload) |
| **Notion** | Productivity | [x] `notion_create_page` (title + markdown → blocks) + `notion_query_database` (filter/sort JSON) |
| **Airtable** | Productivity/Database | [x] `airtable_create_record` / `_list_records` / `_update_record` |
| **Jira** | Project Management | [x] `jira_create_issue` (ADF description) + `jira_search_issues` (JQL); email+token Basic or Bearer |
| **Salesforce** | CRM | [x] `salesforce_create_record` + `salesforce_query` (SOQL via OAuth access token) |
| **HubSpot** | CRM/Marketing | [x] `hubspot_create_contact` + `hubspot_get_contact` (private app token, idProperty= id\|email) |
| **Stripe** | Payments | [x] `stripe_create_customer` + `stripe_create_charge` (PaymentIntent, form-encoded) + `stripe_webhook_trigger` with HMAC-SHA256 signature validation |
| **AWS S3** | Cloud Storage | [x] `aws_s3_put_object` / `_get_object` / `_list_objects` — **hand-rolled SigV4** (no SDK dependency), base64 output for non-text |
| **Telegram** | Communication | [x] `telegram_send_message` (Bot API) + `telegram_trigger` validating `X-Telegram-Bot-Api-Secret-Token` |
| **Discord** | Communication | [x] `discord_send_message` (webhook URL) + `discord_trigger` with **Ed25519 signature verification** (handles PING interaction type=1) |
| **Google Drive** | Cloud Storage | [x] `google_drive_trigger` (polling via Drive API v3) |
| **Google Calendar** | Productivity | [x] `google_calendar_create_event` + `google_calendar_list_events` |
| **Twilio** | SMS/Voice | [x] `twilio_send_sms` (Messages API, Basic auth) |

**Summary** — 26 new node types across 13 integrations, all using `fetch` (no new deps). Three new webhook routes: `/api/webhooks/stripe/:workflowId`, `/api/webhooks/telegram/:workflowId`, `/api/webhooks/discord/:workflowId`. Shipped with 36 unit + integration tests covering action handlers, SigV4 signing, and all three signature-verified webhook routes. Each integration ships a brand-colored SVG logo in `apps/web/public/logos/` and appears in `/api/integrations` alongside the Tier 1 set.

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
- [x] Tags — `tags: string[]` on `WorkflowNode`/`Workflow`; sidebar tag-filter chips; per-card chip display; click-to-toggle filter. Editable via "Tags" button on each card (comma-separated prompt) or `POST /api/workflows/:id/move { tags }`.
- [x] Folders — `folders` table with `parentId` (hierarchy supported in schema) + `project_id` FK; folder sidebar on dashboard with workflow counts; create/delete via `POST|DELETE /api/folders`; deleting a folder orphans workflows back to root (doesn't delete them) and re-parents child folders one level up.
- [x] Projects — `projects` table; `project_id` on workflows and secrets (isolated workspaces); project switcher in top bar; default project bootstrapped on first run + backfills legacy rows; workflow variables stay per-workflow (project-level vars deferred to 5.x). Deleting a non-default project moves its workflows + secrets back to the default project.
- [x] Workflow search by name, tag, content — `GET /api/workflows?search=...&tag=...&folderId=...&projectId=...`; dashboard client-side filter matches name/id/tag substring plus server filters by project. Full workflow-content grep deferred (not yet needed for the card-list UX).
- [x] Workflow duplication — verified end-to-end: duplicates preserve `tags`, `projectId`, and `folderId` from the source (covered by API integration test).

### 4.3 Testing & Debug Tools
**n8n equivalent:** Pin data, debug executions, single-node run
- [x] **Data pinning** — `workflow.pinnedData` stores node output by node ID; editor can pin/unpin last-run output and executor reuses pins without calling node handlers.
- [x] **Execute single node** — `runMode: "single_node"` executes only the selected node using supplied previous `nodeOutputs` and/or pinned parent data.
- [x] **Debug past executions** — execution history rows can load run data back into the editor or re-run from `sourceExecutionId`.
- [x] **Execution preview** — debug mode renders compact input/output/error previews inline on canvas nodes.
- [x] **Schema view** — node inspector infers and displays payload structure from runtime input/output data.
- [x] **Table view** — node inspector includes flattened table inspection for payloads.
- [x] Expression editor with autocomplete and preview — expression fields provide insertable built-in snippets and server-side preview.

### 4.4 Execution History Enhancements
- [x] Filter by status, workflow, date range
- [x] Custom execution metadata (`$execution.customData`)
- [x] Manual retry of failed executions from history
- [x] Execution data retention configuration (max age, pruning)
- [x] Cancel running executions

---

## Phase 5: Enterprise & Operations (Sprints 12-14)

### 5.1 Authentication Enhancements
- [x] SAML 2.0 SSO (Okta, Azure AD, OneLogin) — `SamlService` with `@node-saml/node-saml` as optional dep; graceful 503 when dep/config missing. `GET /api/auth/saml/login`, `POST /api/auth/saml/callback` wire IdP-initiated and SP-initiated flows.
- [x] LDAP / Active Directory integration — `LdapService` with `ldapts` as optional dep; `POST /api/auth/ldap/login` resolves bind DN via user filter and verifies password with a rebind.
- [x] MFA / 2FA with enforcement option — hand-rolled RFC 6238 TOTP in `MfaService` (AES-256-GCM secret at rest, single-use SHA-256-hashed backup codes). `/api/auth/mfa/enroll|activate|disable|status` + login MFA challenge at `/api/auth/login/mfa`; `MFA_ENFORCE=true` forces admin enrolment on next login.
- [x] User provisioning via SSO (group-based role mapping) — `sso_group_mappings` table with global or per-project assignment; SAML/LDAP callbacks auto-provision users, update their global role (never downgrading admins), and seed project memberships from matching groups. Admin-only CRUD at `/api/auth/sso/mappings`.
- [x] API key authentication (for programmatic access) — `ApiKeyService` issues `ao_<prefix>.<secret>` bearer tokens (SHA-256 hashed at rest, optional expiry). `Authorization: Bearer …` now authenticates any `/api/*` route alongside session cookies; `/api/auth/api-keys` CRUD + revoke.

### 5.2 Advanced RBAC & Multi-Tenancy
- [x] Project-level roles (Admin, Editor, Viewer) — `user_project_roles` table + `RbacService` with built-in `project_admin` / `editor` / `viewer` roles. Routes: `GET|POST /api/projects/:id/members`, `DELETE /api/projects/:id/members/:userId`. Permission checks fall back to the existing global role when no membership exists (backwards-compatible).
- [x] Custom roles with granular permissions (Enterprise) — `custom_roles` table with a permission vocabulary (`workflow:read|write|execute|delete`, `secret:read|write|use`, `project:manage|invite`, `role:manage`). Admin-only CRUD at `/api/custom-roles`; assignable to members via `role: "custom", customRoleId: …`.
- [x] Credential sharing scoped to projects — `secret_shares` table + `/api/secrets/:id/shares` CRUD. Secrets still carry an owning `project_id`; shares grant read access from additional projects.
- [x] Cross-project workflow sharing controls — `workflow_shares` table + `/api/workflows/:id/shares` CRUD with `accessLevel: "read" | "execute"`. `RbacService.canAccessWorkflow` honours shares when evaluating permissions.

### 5.3 External Secrets
**n8n equivalent:** AWS Secrets Manager, HashiCorp Vault, Google Secret Manager
- [x] External secrets provider interface — `ExternalSecretsService` with a pluggable `ProviderAdapter` registry (`apps/api/src/services/external-secrets-service.ts`). `SecretService.resolveSecret` transparently dispatches to the adapter when a secret's `source === "external"`.
- [x] AWS Secrets Manager adapter — optional-dep pattern (`@aws-sdk/client-secrets-manager`); 503/CONFIGURATION_ERROR if the SDK is not installed.
- [x] HashiCorp Vault adapter — native `fetch`-based (no extra dep), KV v1 + v2 aware, configurable `field` extraction.
- [x] Google Secret Manager adapter — optional-dep (`@google-cloud/secret-manager`); supports full-path keys (`projects/.../secrets/.../versions/latest`) and short names.
- [x] Azure Key Vault adapter — optional-dep (`@azure/keyvault-secrets` + `@azure/identity`); supports `ClientSecretCredential` via stored JSON or `DefaultAzureCredential` fallback.
- [x] Automatic rotation — `external_secret_cache` table stores each resolved value (re-encrypted with the local master key) with a TTL from the provider config (`cacheTtlMs`). Cache hits within TTL; after expiry the next resolve round-trips to the upstream source. Admin routes: `POST|PUT|DELETE /api/external-providers`, `POST /api/external-providers/:id/test`. `POST /api/secrets` accepts `{ externalProviderId, externalKey }` to register a reference instead of a literal value.

### 5.4 Audit Logging
- [x] Comprehensive audit trail: user auth (register/login/logout/mfa-challenge), MFA enrol/activate/disable, API-key create/revoke, SSO mapping CRUD, secret CRUD (local + external), external-provider CRUD + test, workflow CRUD, execution completion (success/failure), project CRUD, project-member add/remove, custom-role CRUD, workflow/secret sharing. Stored in `audit_logs` with category, event_type, outcome, actor (user/api_key/system), ip, user agent, resource refs, and structured metadata.
- [x] Configurable retention — `AUDIT_LOG_RETENTION_DAYS` (default 365) with a background purge loop mirroring the execution-history pattern; set to 0 to keep entries forever.
- [x] Audit report generation via API — `GET /api/audit` (admin) with filters `category`, `eventType`, `outcome`, `actorUserId`, `resourceType`, `resourceId`, `projectId`, `from`, `to`, `page`, `pageSize`. `GET /api/audit/export` streams a CSV attachment.

### 5.5 Log Streaming
**n8n equivalent:** Syslog, Webhook, Sentry destinations
- [x] Log streaming framework with pluggable destinations — `LogStreamingService` with adapter registry (`registerAdapter`), encrypted-at-rest config (AES-256-GCM with the shared master key), asynchronous buffered dispatch (`LOG_STREAM_BUFFER_SIZE`, `LOG_STREAM_FLUSH_INTERVAL_MS`) with bounded retries (`LOG_STREAM_RETRY_MAX_ATTEMPTS`), per-destination delivery history in `log_stream_events` (retention governed by `LOG_STREAM_EVENT_RETENTION_DAYS`).
- [x] Syslog destination — RFC 5424 framing with configurable facility/appName/hostname; UDP (`dgram`) or TCP (`net`) transport. Severity derived from level (debug/info/warn/error → 7/6/4/3).
- [x] Webhook destination (custom headers) — POSTs JSON via native `fetch`, arbitrary header map, optional HMAC-SHA256 signing with configurable header name (default `x-ao-signature: sha256=<hex>`), method override.
- [x] Sentry destination — classic DSN parsing → event envelope POST to `/api/<projectId>/store/` with `X-Sentry-Auth`; maps level `warn → warning`, tags with category/event_type/outcome.
- [x] Event categories: auth, mfa, sso, api_key, secret, external_secret, workflow, execution, project, rbac, sharing, system — fanned out automatically from the existing `audit()` helper in `apps/api/src/app.ts`. Per-destination category filter + minimum level threshold.
- [x] Configure from Settings UI — new `Log Streams` tab in `SettingsPage` (admin only): destination registration with type-specific sample config, category multi-select, min-level selector, live enable/disable toggle, test button, delivery-event drawer showing attempts/status/errors. Secret config fields (`hmacSecret`, `dsn`) masked as `__secret__` in API responses.
- [x] Routes: `GET|POST /api/log-streams`, `PUT|DELETE /api/log-streams/:id`, `POST /api/log-streams/:id/test`, `GET /api/log-streams/:id/events` — all admin-gated and audit-logged.

### 5.6 Version Control & Environments
**n8n equivalent:** Git-based source control with branch-per-environment
- [x] Connect instance to Git repository — admin-only `PUT /api/git` registers a singleton `git_configs` row (repo URL, default branch, auth secret ref, workflows dir, variables file, commit author). `DELETE /api/git` disconnects and clears the local mirror. `GitSyncService` drives the `git` CLI via `child_process.spawnSync` with `GIT_TERMINAL_PROMPT=0` and a configurable command timeout.
- [x] Push/pull workflows from UI — new `Source Control` tab in `SettingsPage` surfaces repo config, current branch/status, last push/pull timestamps, last error, and exposes Push/Pull buttons. Backend routes: `POST /api/git/push`, `POST /api/git/pull`, `GET /api/git/status`.
- [x] Branch-per-environment (dev, staging, prod) — config stores a default branch; every push/pull call accepts a `branch` override so the same instance can sync different branches for different environments. Working tree is checked out to the requested branch on each operation.
- [x] Workflow history with restore (built-in versioning) — new `workflow_versions` table snapshots every `POST|PUT /api/workflows` (and every git pull/restore) with monotonically increasing version numbers, author, and change note. `GET /api/workflows/:id/versions`, `GET /api/workflows/:id/versions/:n`, `POST /api/workflows/:id/versions/:n/restore`. Retention governed by `WORKFLOW_VERSION_RETENTION` (default 100).
- [x] Credential stubs in export (not secrets) — `GitSyncService.stubCredentials` walks the workflow JSON on push and rewrites every `{ secretId: "sec_..." }` to `{ secretName, secretProvider }` using `SecretService.listSecrets`. `resolveCredentials` reverses the mapping on pull by looking up a local secret with matching name (and provider when present). Unknown stubs are dropped with a warning instead of failing the import.
- [x] Variables included in source control — new `variables` table (project-scoped key/value) drives `{{vars.KEY}}` template interpolation at execution time. Variables are serialised to `variables.json` at the repo root on push and merged back on pull. `GET|POST /api/variables`, `PUT|DELETE /api/variables/:id`, plus a new `Variables` tab in `SettingsPage`. Project vars merged into `workflow.variables` before `executeWorkflow`.

### 5.7 Observability & Metrics
- [x] Prometheus metrics endpoint (`/metrics`) — `GET /metrics` returns text/plain with prefixed counters (`ao_http_requests_total`, `ao_workflow_executions_total`, `ao_workflow_executions_success_total`, `ao_workflow_executions_failure_total`), gauges (`ao_workflow_executions_active`, `ao_uptime_seconds`, `ao_process_heap_used_bytes`, `ao_process_rss_bytes`, `ao_system_load_avg_1m`), and histograms (`ao_http_request_duration_ms`, `ao_workflow_execution_duration_ms`, `ao_node_execution_duration_ms`) with canonical `_bucket{le="..."}`, `_sum`, `_count` triples. Prefix overridable via `METRICS_PREFIX`. Public endpoint (no auth) so Prometheus scrapers can hit it directly.
- [x] Grafana dashboard templates — [ops/grafana/ai-orchestrator-dashboard.json](ops/grafana/ai-orchestrator-dashboard.json) ships a ready-to-import dashboard with 10 panels: active executions, SLO stats, throughput/success/failure rates, histogram quantile latency, HTTP status class distribution, process memory, and system load. See [ops/grafana/README.md](ops/grafana/README.md) for scrape config.
- [x] Distributed tracing (OpenTelemetry) — new `TracingService` produces OTLP-compatible span objects (`traceId`, `spanId`, `parentSpanId`, `operationName`, `attributes`, `events`, `status`, `startTimeMs`/`endTimeMs`/`durationMs`). When `TRACING_ENABLED=true` and `TRACING_ENDPOINT` is set, spans are flushed to the OTLP/HTTP collector in `resourceSpans` format; otherwise the last 5000 spans are retained in memory and exposed via `GET /api/observability/traces` (admin only) for UI visibility.
- [x] Health check endpoint — `GET /health` returns `{ ok, now, uptime, sloHealthy }`. Lightweight and auth-free for liveness/readiness probes. Extended from the previous minimal implementation.
- [x] SLO tracking (execution success rate, p95 latency) — `MetricsService.getSloStatus` computes current success rate and p95 execution latency and compares against `METRICS_SLO_SUCCESS_TARGET` (default 0.99) and `METRICS_SLO_P95_LATENCY_MS` (default 30000). Budgets surfaced as `ao_slo_*` Prometheus gauges and `GET /api/observability/slo`. New `Observability` tab in the Settings UI (admin only) polls every 10s, shows SLO status with healthy/breached chip, execution/HTTP/uptime tables, and recent trace spans.

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
- [x] Kubernetes Helm chart — [ops/helm/ai-orchestrator](ops/helm/ai-orchestrator/) with Chart.yaml, values.yaml, and templates for API deployment, dedicated webhook deployment, web UI, Service, Ingress, ConfigMap, Secret, HPA, ServiceAccount, _helpers.tpl. Supports `api.replicaCount`, `api.haEnabled`, `webhook.enabled`, `ingress.hosts[*].paths[*].service` per-path routing, and optional CPU-based autoscaling.
- [x] Docker Compose production template — [docker-compose.prod.yml](docker-compose.prod.yml) spins up Postgres 16, Redis 7, two API replicas (`HA_ENABLED=true`, distinct `HA_INSTANCE_ID` per container), a `webhook` service (2 replicas, `WORKER_MODE=webhook`), the web UI, and an Nginx front-end that routes `/webhook/*`, `/webhook-test/*`, `/api/webhooks/*` to webhook replicas and everything else to the API replicas. Nginx config at [ops/nginx/ai-orchestrator.conf](ops/nginx/ai-orchestrator.conf).
- [x] AWS ECS Fargate deployment guide — [ops/aws/ecs-fargate.md](ops/aws/ecs-fargate.md) end-to-end walkthrough with topology diagram, Secrets Manager wiring, ALB path-based routing, autoscaling policy, CloudWatch Logs Insights queries for leader transitions. Ready-to-edit task definitions at [ops/aws/task-definition-api.example.json](ops/aws/task-definition-api.example.json) and [ops/aws/task-definition-webhook.example.json](ops/aws/task-definition-webhook.example.json).
- [x] Multi-main high availability (leader election) — `LeaderElectionService` in [apps/api/src/services/leader-election-service.ts](apps/api/src/services/leader-election-service.ts) uses a new `leader_leases` DB table (v10 migration) with atomic `tryAcquireLease` (insert-or-steal-if-expired, renew-if-owner). Enabled via `HA_ENABLED=true`; each replica advertises its `HA_INSTANCE_ID` (fed by downward API in Helm / env in ECS). `onBecomeLeader` callback starts `SchedulerService.initialize()` + `TriggerService.initialize()`; `onResignLeader` stops them. Lease TTL/renew configurable (`HA_LEASE_TTL_MS` / `HA_RENEW_INTERVAL_MS`). Admin status route `GET /api/ha/status` returns current holder + lease expiry + all tracked leases.
- [x] Webhook-specific process separation — new `WORKER_MODE` config var (`all` | `api` | `webhook` | `worker`). In `webhook` mode, `index.ts` skips scheduler/queue/trigger service construction entirely; the surviving Fastify app serves `/health`, `/metrics`, `/widget.js`, and every webhook route without running cron or background workers. Covered by both the Helm chart (`webhook.enabled=true`) and the compose/ECS topologies.

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
