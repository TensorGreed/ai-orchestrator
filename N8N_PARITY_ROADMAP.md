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
- [ ] Expression editor with autocomplete and syntax highlighting in UI (deferred to Phase 4 — UI work) (partial: `NodeConfigModal.tsx` `ExpressionField` suggestions + `POST /api/expressions/preview`, missing: syntax highlighting)

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
- [x] Standardized node package format (`l2m-nodes-*` npm packages) — `apps/api/src/services/community-package-loader.ts` `l2m-nodes-*` loader
- [ ] Node package manifest (name, version, description, node types, credentials) (partial: package.json `l2m` field with kind + apiVersion validated, missing: version/description/node types/credentials manifest fields)
- [x] Install community nodes from UI (Settings > Community Nodes) — `apps/web/src/components/SettingsPage.tsx` `CommunityNodesTab`
- [ ] Node discovery registry / marketplace
- [ ] Node sandboxing for untrusted packages (partial: `--ignore-scripts` install + `COMMUNITY_NODES_ALLOWLIST`, missing: runtime isolation of package code)
- [x] Hot-reload on install (no restart required) — `apps/api/src/app.ts` `POST /api/community-nodes/reload`

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
- [x] Plan-and-Execute agent type — `packages/agent-runtime/src/default-agent-runtime.ts` `plan-and-execute`
- [x] ReAct agent type — `packages/agent-runtime/src/default-agent-runtime.ts` `react`
- [ ] SQL Agent (natural language to SQL) (partial: `sql` agentType adds SQL instructions to the system prompt in `packages/agent-runtime/src/default-agent-runtime.ts`, missing: schema introspection and query tools)
- [x] Agent type selection in agent_orchestrator config — `apps/web/src/components/NodeConfigModal.tsx` `agentType`

### 6.2 LangChain-Style Chains
**n8n equivalent:** Basic LLM Chain, QA Chain, Summarization Chain, extractors, classifiers
- [x] `basic_llm_chain` — simple prompt → response — `packages/workflow-engine/src/executor.ts` `basic_llm_chain`
- [x] `qa_chain` — RAG question answering (enhance existing rag_retrieve) — `packages/workflow-engine/src/executor.ts` `qa_chain`
- [x] `summarization_chain` — document summarization — `packages/workflow-engine/src/executor.ts` `summarization_chain`
- [x] `information_extractor` — structured extraction from text — `packages/workflow-engine/src/executor.ts` `information_extractor`
- [x] `text_classifier` — classify text into categories — `packages/workflow-engine/src/executor.ts` `text_classifier`
- [x] `sentiment_analysis` — sentiment scoring — `packages/workflow-engine/src/executor.ts` `sentiment_analysis`

### 6.3 Additional AI Infrastructure
- [ ] Additional embedding adapters: AWS Bedrock, Cohere, Google Vertex, Mistral, HuggingFace (partial: Cohere, Mistral, Google Vertex, HuggingFace in `packages/workflow-engine/src/rag-adapters.ts`, missing: AWS Bedrock)
- [ ] Additional vector stores: Chroma, Weaviate, Supabase, MongoDB Atlas, Milvus, Redis, Zep (partial: Chroma, Weaviate, Redis in `rag-adapters.ts`, missing: Supabase, MongoDB Atlas, Milvus, Zep)
- [ ] Additional memory backends: MongoDB, PostgreSQL, Redis, Zep
- [x] Text splitters: Character, Recursive Character, Token — `packages/workflow-engine/src/chunker.ts` character/recursive/token strategies
- [ ] Retrievers: Contextual Compression, MultiQuery, Workflow Retriever
- [x] AI evaluation framework (test/evaluate agent performance) — `apps/api/src/app.ts` `POST /api/eval/runs`
- [x] AI Transform node (natural language to code) — `packages/workflow-engine/src/executor.ts` `ai_transform`
- [x] Guardrails node enhancement (validate AI outputs against schemas) — `packages/workflow-engine/src/executor.ts` `matches_schema` check

### 6.4 AI Tools Expansion
- [ ] Wikipedia tool
- [ ] Web search tool (SerpAPI / SearXNG)
- [ ] Wolfram Alpha tool
- [ ] Think tool (agent reasoning step)
- [ ] Workflow-as-tool (call another workflow as an agent tool)
- [x] Agent-as-tool (call another agent as a tool) — `supervisor_node` in `packages/shared/src/definitions.ts` (workers as synthetic tools)

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
- [x] Execution data pruning (configurable retention) — `apps/api/src/app.ts` `pruneExecutionHistory` (`EXECUTION_HISTORY_RETENTION_DAYS`)
- [ ] Large workflow optimization (1000+ nodes) (partial: `computeDepthLevels` + DescendantCache in `packages/workflow-engine/src/validation.ts` with `performance.test.ts` (500-node sort), missing: 1000+ node executor path)
- [ ] Binary data handling (file passthrough between nodes) (partial: `packages/workflow-engine/src/binary-store.ts` `FileSystemBinaryStore` + file nodes, missing: executor/API wiring of `binaryDataStore`)
- [ ] Streaming execution for large datasets (item-level processing)

### 7.3 API Completeness
**n8n equivalent:** Full OpenAPI 3.0 REST API
- [x] OpenAPI 3.0 spec generation — `apps/api/src/app.ts` `GET /api/openapi.json`
- [x] API key authentication — `apps/api/src/services/api-key-service.ts`
- [x] Workflow activate/deactivate endpoints — `apps/api/src/app.ts` `POST /api/workflows/:id/activate`
- [x] Workflow transfer between projects — `apps/api/src/app.ts` `POST /api/workflows/:id/transfer`
- [x] Execution stop/cancel endpoint — `apps/api/src/app.ts` `POST /api/executions/:id/cancel`
- [x] Credential schema endpoint — `apps/api/src/app.ts` `GET /api/secrets/schema`
- [ ] User invite/management endpoints (partial: `PUT /api/users/:id` and project member invites in `apps/api/src/app.ts`, missing: a deployment-level user invite endpoint)
- [x] Project CRUD endpoints — `apps/api/src/app.ts` `POST /api/projects`
- [ ] Tag CRUD endpoints (partial: `GET`/`POST`/`DELETE /api/tags` in `apps/api/src/app.ts`, missing: rename via `PUT`)
- [x] Variable CRUD endpoints — `apps/api/src/app.ts` `POST /api/variables`
- [x] Source control push/pull endpoints — `apps/api/src/app.ts` `POST /api/git/push`
- [x] Audit report endpoint — `apps/api/src/app.ts` `GET /api/audit/export`
- [ ] Pagination on all list endpoints (partial: `page`/`pageSize` on `GET /api/executions`, missing: other list endpoints)

### 7.4 Workflow Templates & Sharing
- [x] Template library with categories — `apps/api/src/app.ts` `GET /api/templates`
- [x] One-click import from template gallery — `apps/api/src/app.ts` `POST /api/templates/:id/use`
- [x] Workflow export/share via URL — `apps/api/src/app.ts` `GET /api/workflows/:id/share-link`
- [ ] Community template submissions (partial: `POST /api/templates` for admin/builder, missing: moderation/public submission flow)
- [x] Template search and filtering — `apps/web/src/components/TemplateGallery.tsx`

### 7.5 Notifications
- [x] Error notification framework (via error workflows) — `apps/api/src/services/notification-service.ts`
- [x] Built-in email notification on workflow failure — `apps/api/src/services/notification-service.ts` SMTP channel
- [x] Slack/Teams webhook notification presets — `apps/api/src/services/notification-service.ts` slack/teams channels
- [x] Notification preferences in Settings UI — `apps/web/src/components/SettingsPage.tsx` `NotificationsTab`

---

## Phase 8: Orbit UI Revamp (in progress, branch `ui/orbit`)

Visual identity change so the Studio stops reading as an n8n clone while keeping every
feature. Brief: [apps/web/DESIGN.md](apps/web/DESIGN.md); chosen prototype:
`apps/web/prototype/ui-revamp.html` (direction B · Orbit, with Loom's run tape, docked
inspector, slot rows and stage auto-layout).
- [x] Shell: collapsible sidebar, floating HUD pills, ⌘K command palette, restyled login
- [x] Editor: hub nodes for agents with ring slots, stage strip, Tidy auto-layout, run tape, node palette
- [x] Inspector: docked drawer with Parameters / Input / Output / Trace, Slots section
- [x] Pages: dashboard cards with one primary action + overflow menu, runs, settings, chat, secrets, templates, KB
- [x] Both themes verified in a browser (dashboard, editor, inspector, runs, settings, templates, chat, KB); legacy `styles.css` reduced to ~250 lines of shared helpers on tokens
- [x] Playwright golden-journey spec updated to the new selectors
- [ ] Delete `apps/web/prototype/` once the direction is signed off

## Phase 9: n8n Workflow Importer (scheduled after Phase 8)

**Why:** lowest-friction way for n8n users to try L2M on a flow they already have. Interop
beats replacement; the importer plus "workflow as MCP tool" lets L2M sit next to n8n.

### 9.1 Import pipeline
- [x] `POST /api/workflows/import/external` accepting an n8n workflow export (`nodes[]`, `connections{}`, `settings`, `pinData`), with `dryRun`, project/folder targeting and an audit event
- [x] Pure converter in `packages/workflow-engine/src/import/external-builder.ts`: n8n node → L2M node type map, `connections` → edges (main outputs, index-based ports → `if`/`switch` handles), positions carried over, sticky notes → `sticky_note`
- [x] Expression translation for the common subset: `{{ $json.x }}` → `{{results.<prev>.x}}`, `$node["Name"].json` → `results.<id>`, `$now`, `$env` → variables; unknown expressions preserved verbatim and flagged
- [x] Credentials: n8n `credentials` refs become `secretRef` placeholders with a post-import "resolve secrets" checklist, never raw values
- [x] Import report: per-node `mapped | approximated | unsupported` with reasons; unsupported nodes become disabled `noop_node` placeholders carrying the original config so the flow still loads

### 9.2 Node coverage (first wave, by n8n usage frequency)
- [x] Triggers: Manual, Webhook, Schedule/Cron, Chat Trigger, Error Trigger, Form Trigger, RSS, Email (IMAP)
- [x] Core: HTTP Request, Code (JS/Python), Set/Edit Fields, IF, Switch, Merge, Split Out, Aggregate, Filter, Sort, Limit, Wait, No Op, Stop and Error, Execute Workflow, Sticky Note
- [x] AI: OpenAI / Anthropic / Gemini / Ollama chat models → `*_chat_model`, AI Agent → `agent_orchestrator` (sub-node connections `ai_languageModel` / `ai_memory` / `ai_tool` → `chat_model` / `memory` / `tool` attachment edges), Simple Memory → `local_memory`, MCP Client Tool → `mcp_tool`, Structured Output Parser → `output_parser` (vector stores → existing RAG nodes still open)
- [x] Apps with existing Tier 1/2 connectors: Slack, GitHub, Google Sheets, Postgres, Notion, Jira, Airtable, HubSpot, Salesforce, Stripe, S3, Telegram, Discord (resource/operation pairs dispatched onto the existing connector nodes in `packages/workflow-engine/src/import/apps/`; unsupported pairs stay disabled placeholders)

### 9.3 UX
- [x] "Import from n8n" in the HUD overflow and the command palette; drag an n8n JSON onto the canvas
- [x] Post-import panel: mapping report, secrets to resolve, one-click Tidy layout, "Run a dry validation"
- [x] Docs page "Importing a workflow from another builder" with the coverage table generated from the converter's map (`pnpm --filter @ai-orchestrator/workflow-engine gen:import-coverage`)
- [x] Fixture corpus of real exports under `samples/external-imports/` with golden-file tests

## Phase 10: MCP Control Plane (after Phase 9)

**Positioning:** L2M is self-hosted. Everything in Phases 10-14 runs inside the user's own
deployment (SQLite or Postgres, single binary or docker compose). No hosted service, no
phone-home, no vendor-side registry; anything that would need a shared backend is designed
as a local file or an endpoint on the user's own instance.

### 10.1 MCP server registry
- [x] Registry page listing every configured MCP server (transport, endpoint, auth secretRef, owner, last probe) backed by a `mcp_servers` table; MCP Tool nodes and agent `mcpServers` entries reference it with `registryServerId`
- [x] Health probe service: periodic `initialize` + `tools/list`, status history, latency percentiles (leader-only, `MCP_PROBE_INTERVAL_MS`, per-server override)
- [x] Tool schema snapshots per probe; diff view when a server adds, removes, or changes a tool's input schema; optional "block runs on breaking change" setting
- [x] Per-tool telemetry rollup from execution traces: call count, p50/p95 latency, error rate, token cost of the agent turns that invoked it (`mcp_tool_calls`, migration v21; `GET /api/mcp/servers/:id/telemetry`, `GET /api/mcp/telemetry`; columns on the server page's Tools table)

### 10.2 Tool policy
- [x] Allow/deny policies per role and per project: which servers and which tools an agent may call; enforced in `agent-runtime` tool discovery (filtered out, not just hidden) (`mcp_tool_policies`, migration v22; deny wins, a strictly narrower allow carves an exception; discovery filter plus call-time check; unattended runs use the workflow creator's role, `workflows.created_by`)
- [x] Read-only tool classification (from annotations when the server provides them, else manual) and a "no write tools" switch per workflow (`mcp_tool_classifications`; `readOnlyHint` kept in tool snapshots; unknown counts as write; `settings.noWriteTools`)
- [x] Policy evaluation visible in the Trace tab: "tool X hidden by policy Y" (`_toolPolicy` on agent outputs with the evaluated subject; `POST /api/mcp/policies/evaluate` dry-run)

### 10.3 Control plane UI
- [x] "MCP" section in the sidebar: servers, tools, policies, changes feed (Overview, Servers, Tools, Policies, Toolsets, Clients, Playground and Changes pages; `GET /api/mcp/overview`, `/api/mcp/tools`, `/api/mcp/changes`)
- [x] Orbit canvas integration: tool satellites show probe status and policy state (plus a pending breaking-change marker; one cached request per workflow, refreshed on focus)

### 10.4 L2M as an MCP server and gateway
**Why:** today a workflow exposed with `mcp_server_trigger` is reachable only through a custom
manifest/invoke REST pair, so standard MCP clients cannot connect. A spec-compliant endpoint makes
L2M the one governed MCP hub that every AI client in an organisation points at.
- [x] Spec-compliant Streamable HTTP MCP endpoint (JSON-RPC `initialize`, `tools/list`, `tools/call`, progress and cancellation) that IDE agents, desktop assistants and other L2M instances connect to directly; the existing REST pair stays for compatibility
- [x] Workflows with `mcp_server_trigger` become tools on that endpoint, grouped into named toolsets with one URL each
- [x] Gateway mode: re-expose registered servers' tools through the same endpoint so every call gets L2M's secret injection, tool policy (10.2), telemetry (10.1) and audit log; local stdio servers become reachable without exposing the host
- [x] Client credentials: per-client tokens hashed at rest, each scoped to toolsets and a role; a "Connect a client" page with copy-paste config snippets and per-client usage

### 10.5 Protocol coverage on the client side
- [x] Structured tool output: `outputSchema` and `structuredContent` kept in snapshots, validated, and passed to downstream nodes as typed data
- [x] Tool annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`) captured, shown on the registry page and used by policy (approval gates use them with 11.2)
- [x] Resources and prompts: browse and read resources, use server prompts as templates in agent and LLM nodes; `list_changed` notifications trigger a re-probe
- [x] Progress notifications streamed to the run tape; cancelling a run sends `notifications/cancelled` to in-flight tool calls
- [x] Elicitation: a server asking for user input pauses the run through the existing wait/resume and clarification plumbing
- [x] Sampling: servers may request completions through the agent's attached chat model, gated by policy and counted in cost telemetry
- [x] OAuth 2.1 for remote MCP servers (metadata discovery, PKCE, dynamic client registration, token refresh) with tokens held by `SecretService`

### 10.6 Onboarding and catalog
- [x] Import existing MCP client config files (`mcp.json`, `.vscode/mcp.json` and desktop-assistant configs) into the registry in one step, turning env values into secrets
- [x] Deployment-local catalog file of approved servers with pinned package versions; presets read from it, no vendor-side registry
- [x] MCP playground page: pick a server, call any tool through a schema-driven form, read resources and preview prompts, inspect the raw JSON-RPC exchange

### 10.7 Runtime safety
- [ ] Sandboxed stdio servers: optional container runner (docker or podman) with CPU and memory limits, read-only root, an allowlist of mounted roots and networking off by default
- [ ] Per-server and per-tool rate limits, concurrency caps and a circuit breaker that opens on repeated failures and shows on the registry page
- [ ] Tool output guard: secret and PII redaction plus prompt-injection heuristics on tool results before they reach the model, with findings in the trace (delivered by Phase 12, L2M Guard)
- [ ] Delegated credentials: a tool call can use the triggering user's own token for a server instead of a shared service secret

### 10.8 Testing and reliability
- [ ] Record and replay: capture a run's tool calls as a cassette and replay runs and evals deterministically against it
- [ ] Mock server from a snapshot: generate a stub MCP server from a schema snapshot for tests and offline demos
- [ ] `l2m mcp check` CLI for CI: probe servers and fail on breaking schema changes against the accepted snapshot

## Phase 11: Audit Bundles & Approvals (after Phase 10)

### 11.1 Signed run manifests
- [ ] Per execution, a manifest recording workflow version hash, every node's resolved config (secret refs only), provider + model + parameters, tool server identities + schema snapshot hashes, prompts, citations, token and cost totals
- [ ] Manifest signed with a per-deployment key (`AUDIT_SIGNING_KEY_BASE64`, generated locally, stored like `SECRET_MASTER_KEY_BASE64`); verification CLI `l2m audit verify <bundle>` that runs offline
- [ ] Export "audit bundle" (zip: manifest, node I/O, trace, logs, rendered outputs) from the Runs page and via `GET /api/executions/:id/bundle`; retention follows the existing audit-log retention setting

### 11.2 Approval gates
- [ ] `approval_gate` node: pauses the run, records who may approve (role/user), optional timeout and fallback branch; resumes through the existing wait/resume plumbing
- [ ] Approvals inbox page and notifications through the existing notification channels; approve/reject from the Runs page with a reason that lands in the manifest
- [ ] Agent-level gate: require approval before any tool classified as a write tool is called (configurable per workflow)

## Phase 12: L2M Guard — security proxy for AI traffic

**Why:** agents now read untrusted content (web pages, emails, tickets, tool results) and hold
write access to real systems. A guard that sits on every trust boundary, understands where data
came from and enforces policy on what an agent may do turns L2M from a builder into the safe way
to run agents.

**Design principles**
- One guard engine, four enforcement points: an explicit `guard` node on DAG edges; a `guard`
  attachment port on agents whose hooks run inside the agent loop (before each model call, before
  each tool call, after each tool result, before the final answer), which is how agent ↔ MCP
  traffic is covered without breaking attachment-port semantics; automatic guard profiles bound to
  projects and workflows; and traffic entering through the MCP gateway (10.4) and the AI gateway (12.6).
- Detect, then act: allow, block, redact, transform, require approval or route to review, with a
  shadow mode for every action so policies can be observed before they are enforced.
- Provenance over pattern matching: data carries labels for where it came from, so defences hold
  against injection phrasings no detector has seen.
- Self-hosted: rules, parsers and local models (ONNX runtime or Ollama) run in the deployment; an
  LLM judge uses a model the workflow already has configured; no third-party scanning service.
- Measured: every verdict is recorded and every profile is benchmarked against an attack corpus.

### 12.1 Guard engine and placement
- [ ] `packages/guard-sdk`: detector interface (content, channel — prompt, model output, tool arguments, tool result, final output —, provenance labels and run subject in; findings with score, span and evidence out) and `createDefaultGuardRegistry()`; community detectors through the node SDK — *partial:* detector interface, channels, provenance labels, run subject, findings with score, spans and masked evidence, and `createDefaultGuardRegistry()` are delivered; community detectors through the node SDK remain
- [ ] Guard profiles: named, versioned bundles of detectors, thresholds and actions per channel, stored as policy-as-code and synced through git — *partial:* the zod-validated profile document, stable serialisation and hash are delivered; storage and git sync remain
- [ ] `guard` node for DAG edges with `pass`, `blocked` and `review` outputs, so flagged items can be routed instead of failing the run
- [ ] `guard` attachment port on Agent and Supervisor nodes: hooks before each model call, before each tool call, after each tool result and before the final answer, also applied to worker delegation
- [ ] Automatic boundary profiles per project and per workflow (inherit, override, or enforced by an admin so builders cannot remove them)
- [ ] Actions: allow, block, redact or mask, tokenise or encrypt through an attached protection provider (12.5), transform, require approval (11.2), route to review; per-action shadow mode — *partial:* every action and per-action shadow mode are delivered in `evaluateGuard`; the `protection` port and the approval-flow hand-off remain
- [ ] Latency tiers: rules and parsers inline, local classifiers next, LLM judge only for uncertain scores; per-profile latency budget with an explicit fail-open or fail-closed choice — *partial:* tiers, cheapest-first evaluation, the per-profile budget and fail-open / fail-closed are delivered; local classifier models and the LLM judge remain (interfaces only)

### 12.2 Prompt-injection and jailbreak defence
- [ ] Direct injection and jailbreak detection on user input: rule pack plus a local classifier model, with scores and highlighted spans — *partial:* rule pack with scores and spans, leetspeak and base64 decoding delivered; the local classifier model remains (interface with a rule-based stand-in)
- [ ] Indirect injection scanning of tool results, retrieved documents, web pages, emails and webhook payloads before the model sees them — *partial:* indirect rule pack delivered as a library; scanning before the model sees the content is wiring
- [ ] Spotlighting: untrusted content wrapped with delimiters or datamarking, with matching system-prompt hardening applied automatically — *partial:* delimiter wrapping, datamarking and the matching system-prompt text delivered as helpers; automatic application is wiring
- [ ] Provenance (taint) tracking: values carry labels (trusted, user, untrusted external, sensitive) through templates, nodes and the agent context; policies such as "once untrusted content is in context, write tools need approval" and "sensitive data may not flow to open-world tools" — *partial:* detector input carries the labels and the indirect pack keys on `untrusted_external`; carrying labels through templates, nodes and the agent context, and the label-based policies, remain
- [x] Exfiltration channels blocked: markdown images and links that encode data in URLs, unexpected outbound URLs in tool arguments, hidden-unicode and ASCII-smuggling payloads — library in `packages/guard-sdk`; wiring into nodes, runtime and API in the guard node PR
- [x] Canary tokens in system prompts to detect prompt leakage in outputs — library in `packages/guard-sdk`; wiring into nodes, runtime and API in the guard node PR

### 12.3 Tool-argument security
- [x] SQL guard: statements parsed to an AST per dialect; read, write and DDL classified; stacked queries, tautologies and comment tricks blocked; table and column allowlists; mutations require WHERE and a row cap; applied to SQL connector nodes and SQL-shaped MCP arguments — library in `packages/guard-sdk` (postgres, mysql, mariadb, sqlite, mssql); applying it to SQL connector nodes and MCP arguments is wiring
- [x] Command guard: shell metacharacter and argument-injection checks for tools that run commands; static checks on code-node source — library in `packages/guard-sdk`; wiring into nodes, runtime and API in the guard node PR
- [x] Path guard: path arguments resolved against allowed roots; traversal and symlink escapes blocked — library in `packages/guard-sdk`; wiring into nodes, runtime and API in the guard node PR
- [x] Egress guard: URL arguments and HTTP nodes checked against an allowlist after DNS resolution; private ranges, link-local and cloud metadata addresses blocked — library in `packages/guard-sdk` with an injectable resolver; HTTP nodes and tool calls are wired in the guard node PR
- [x] Strict argument validation against the tool's input schema with size and depth limits before every call — library in `packages/guard-sdk`; wiring into nodes, runtime and API in the guard node PR

### 12.4 Fine-grained access control for agents
- [ ] Attribute-based policies on tool calls written in Cedar (embedded, open source): principal is the run subject (10.2) or gateway client, action is the server and tool, resource and context come from the arguments and data labels — e.g. "operators may create issues only in org X's repositories", "refunds above 500 need a manager's approval"
- [ ] Delegated identity: tool calls carry the end user's identity to downstream systems (token exchange or on-behalf-of) so the target system's own IAM applies; builds on 10.7 delegated credentials
- [ ] Least-privilege suggestions: from telemetry, propose a policy that allows only the tools and argument ranges a workflow actually uses
- [ ] Policy simulation: replay recent runs against a draft policy and show what would have been blocked before enforcing it

### 12.5 Data protection and output safety
- [ ] DLP detectors: PII, PHI and card data (patterns with checksums plus a local NER model), credentials and keys, custom dictionaries and patterns — *partial:* pattern detectors with checksums, credentials and keys, custom dictionaries and patterns delivered; the local NER model remains
- [ ] Pluggable protection providers: a provider interface (`protect` / `reveal`) in `packages/guard-sdk` with `createDefaultProtectionRegistry()`; providers attach to a guard node or profile through a `protection` port (0..N), so an external tokeniser or encrypter can be plugged in without changing the guard — *partial:* interface and `createDefaultProtectionRegistry()` delivered; the `protection` port remains
- [ ] Built-in providers: local token vault (random or deterministic, format-preserving tokens), format-preserving encryption and AES-GCM encryption with keys held by `SecretService` or a customer KMS (13.3), keyed hashing for irreversible pseudonyms, and masking — *partial:* token vault (random, deterministic, format-preserving tokens), AES-GCM, keyed hashing and masking delivered with an injected key resolver; format-preserving encryption and the `SecretService` / KMS key wiring remain
- [ ] External providers: a generic HTTP adapter for an organisation's own tokenisation or encryption service (auth through `secretRef`), plus adapters for vault transform/transit engines and cloud de-identification APIs; community providers through the node SDK
- [x] Per data-class mapping in the profile: each detected class (card number, email, national id, credential, custom class) maps to a provider and a mode (reversible token, encryption, pseudonym, mask); deterministic modes keep joins and lookups working across runs — library in `packages/guard-sdk`; wiring into nodes, runtime and API in the guard node PR
- [ ] Applied on every channel where data can leak: MCP tool responses (after each tool result, before the model sees them), workflow and node outputs, webhook and chat responses, and both gateways
- [ ] Controlled reveal: a `reveal` step (node or output-side action) restores original values only for destinations and subjects a policy allows; every reveal is audited — *partial:* providers implement `reveal`; the reveal step, destination policy and audit remain
- [x] Fallback policy: when sensitive data is found and no provider covers its class, or the provider is unavailable or errors, the profile's fallback applies, which defaults to deny (block the response or fail the step); prompt-injection findings are never tokenised and always follow their own block or review action — library in `packages/guard-sdk`; wiring into nodes, runtime and API in the guard node PR
- [ ] Output checks: content-safety classifier, topic restrictions, schema conformance (extends `output_guardrail`), grounding check against retrieved citations
- [ ] Guarded data also redacted in execution history, logs, traces and telemetry

### 12.6 AI gateway for applications outside L2M
- [ ] OpenAI-compatible `/v1/chat/completions` and `/v1/embeddings` endpoints that apply a guard profile and route through the provider registry, so other applications send model traffic through the same guard, budgets and audit
- [ ] Guard profiles applied per toolset and per client on the MCP gateway (10.4)
- [ ] Per-client and per-project token budgets, rate limits and model allowlists

### 12.7 Visibility and assurance
- [ ] Every verdict stored (`guard_events`: channel, detector, score, action, masked evidence spans, profile version) and shown in the Trace tab, run tape and a Security page with trends
- [ ] Guard events streamed to SIEM destinations through log streaming and included in signed run manifests (11.1)
- [ ] Red-team corpus and benchmark: attack suites (direct and indirect injection, SQL injection, exfiltration, jailbreaks) run through the eval framework, reporting detection and false-positive rates per profile; CI gate on regressions — *partial:* a labelled corpus and a vitest gate on detection and false-positive rates for the default profile are delivered; running suites through the eval framework per profile and the CI report remain
- [ ] Framework mapping in the docs: OWASP Top 10 for LLM applications and for agentic applications, MITRE ATLAS, NIST AI RMF — *partial:* the OWASP Top 10 for LLM applications table is in the guard engine docs; agentic applications, MITRE ATLAS and NIST AI RMF remain

## Phase 13: Enterprise readiness

**Why:** what a security review, a procurement questionnaire and a platform team need before L2M
can run in production at a large organisation. L2M already has SAML, LDAP, MFA, SSO group
mapping, custom roles, API keys, external secret stores, audit log with retention, log streaming,
git-backed environments, Prometheus metrics, tracing and a Helm chart. The gaps below are ordered
by what blocks adoption first. All of it stays self-hosted.

### 13.1 Production data tier
- [ ] Full Postgres parity: every SQLite store method implemented for Postgres (recent features ship schema-only there) and the whole API test suite run against Postgres in CI
- [ ] Horizontal scaling: shared work queue (Postgres `SKIP LOCKED` or Redis) with stateless API replicas and worker pools, load-tested with several replicas
- [ ] Zero-downtime upgrades: expand-and-contract migrations, rolling deploys, migration dry runs
- [ ] Backup, restore and disaster-recovery runbook with stated RPO and RTO; restore drills in CI
- [ ] External object storage for execution payloads and binaries (S3-compatible, server-side encryption with customer keys)

### 13.2 Identity and access
- [ ] OIDC single sign-on alongside SAML
- [ ] SCIM 2.0 provisioning and deprovisioning of users and groups, with immediate session revocation
- [ ] Session policy: idle and absolute timeouts, concurrent-session limits, MFA required per role, step-up authentication for sensitive actions
- [ ] Network controls: IP allowlists for UI, API and webhooks, trusted-proxy configuration, mutual TLS option for the MCP gateway
- [ ] Service accounts with scoped, rotating keys; break-glass admin access with alerting

### 13.3 Data protection and tenancy
- [ ] Envelope encryption with customer-managed keys (cloud KMS services and Vault Transit); master-key rotation without downtime
- [ ] Retention per project for executions, logs and guard events; legal hold; data-subject export and deletion
- [ ] Field-level encryption of execution inputs and outputs at rest
- [ ] Organisations above projects: isolated tenants in one deployment with their own admins, SSO, keys and quotas

### 13.4 Governance and change control
- [ ] Environments as a first-class concept (dev, staging, prod) with promotion, diffs and required approvals; protected production workflows need a second reviewer before activation
- [ ] Signed, attributable changes to workflows and policies; all admin configuration exportable as code and synced through git
- [ ] Usage and cost chargeback per organisation, project and team, with budgets and alerts
- [ ] Periodic access reviews: who can do what in each project, with attestation

### 13.5 Supply chain and deployment
- [ ] SBOM (CycloneDX) per release, signed container images and build provenance; vulnerability policy with a disclosure SLA in SECURITY.md
- [ ] Air-gapped installation: offline image bundle, no outbound calls, bundled local guard models, documented ports and egress
- [ ] FIPS 140-3 mode and hardened images (non-root, read-only filesystem, minimal base)
- [ ] Kubernetes reference architecture (autoscaling, disruption budgets, network policies, external Postgres) and Terraform examples per cloud
- [ ] Long-term-support release line with security backports and a published upgrade policy

### 13.6 Compliance and trust
- [ ] Control-mapping documents for customer audits (SOC 2, ISO 27001, HIPAA, GDPR, EU AI Act, NIST AI RMF) with a shared-responsibility model for self-hosted deployments
- [ ] Security whitepaper, threat model and a third-party penetration-test summary; evidence export for auditors (audit log, access reviews, configuration snapshots)
- [ ] Accessibility audit to WCAG 2.2 AA with a VPAT; localisation framework

### 13.7 Commercial readiness
- [ ] Editions and an offline-verifiable licence file (signed, no phone-home) for enterprise features; the open-core boundary is a product decision still to make
- [ ] Support tiers with severity SLAs, an enterprise admin guide, a sizing guide and published performance benchmarks

## Phase 14: Future (not scheduled)

Ideas from the positioning discussion, kept for later; each must remain self-hosted.
- [ ] Reference deployment bundles: docker compose profiles that ship L2M with a curated set of open-source MCP servers (GitHub, Postgres, filesystem, Slack) and five tested workflows; first bundle: security / key-management reporting
- [ ] Local eval benchmarks: run one workflow across providers and produce a cost / latency / accuracy report as a workflow output (no central leaderboard; users publish their own if they want)
- [ ] Swarm depth: worker pools with token budgets, parallel fan-out with merge strategies, checkpoint and resume for long-running agents, delegation trace on the Orbit canvas
- [ ] Workflow → standalone MCP server exporter (package a workflow so Claude Code, Cursor or another L2M can call it) to keep lock-in low (the in-instance endpoint is 10.4; this item is the standalone package)
- [ ] "MCP agent operations" checklist and maturity model in the docs

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
