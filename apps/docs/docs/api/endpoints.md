# API Endpoints

## Auth

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`

## Workflows

- `GET /api/workflows`
- `GET /api/workflows/:id`
- `POST /api/workflows`
- `PUT /api/workflows/:id`
- `DELETE /api/workflows/:id`
- `POST /api/workflows/:id/duplicate`
- `POST /api/workflows/import`
- `POST /api/workflows/import/external` — convert an export from another builder; see [Importing from another builder](../product/importing-from-another-builder.md)
- `GET /api/workflows/:id/export`
- `POST /api/workflows/:id/validate`
- `POST /api/workflows/:id/execute` (`record: true` records the run's MCP calls into a cassette; the result carries `mcpCassette`)
- `POST /api/workflows/:id/execute/stream` — SSE: `node_start`, `node_complete`, `llm_delta`, `node_progress` (MCP progress: `nodeId`, `toolName`, `serverId`, `registryServerId`, `progress`, `total`, `percent`, `message`, `at`), `result`

## Execution history

- `GET /api/executions` (recorded runs carry `mcpCassette: { id, callCount, truncated }`; runs saved as golden runs carry `goldenRuns: { count, latestId }`)
- `GET /api/executions/:id`
- `POST /api/executions/:id/replay` (builder; `{ mode?: "strict" | "lenient", cassetteId? }`; 404 without a cassette; see [MCP testing](#mcp-testing))

## Definitions and integrations

- `GET /api/definitions`
- `POST /api/connectors/test`
- `POST /api/mcp/discover-tools` (optional `projectId`; each tool carries `classification` and an `access` mark for the caller's role)

## MCP server registry

See [MCP server registry](../product/mcp-server-registry.md).

- `GET /api/mcp/servers`
- `POST /api/mcp/servers`
- `GET /api/mcp/servers/:id`
- `PUT /api/mcp/servers/:id`
- `DELETE /api/mcp/servers/:id`
- `POST /api/mcp/servers/:id/probe`
- `GET /api/mcp/servers/:id/tools?projectId=` (each tool carries `classification`, `manualReadOnly` and an `access` mark for the caller's role)
- `PUT /api/mcp/servers/:id/tools/:toolName/classification` (admin; `{ readOnly: true | false | null }`)
- `GET /api/mcp/servers/:id/snapshots/:snapshotId`
- `POST /api/mcp/servers/:id/accept-change`
- `GET /api/mcp/servers/:id/telemetry?window=24h|7d|30d`
- `GET /api/mcp/servers/:id/oauth` (builder; OAuth connection status, never tokens)
- `POST /api/mcp/servers/:id/oauth/connect` (admin; `{ scope? }` → `{ authorizationUrl, expiresAt, redirectUri }`)
- `POST /api/mcp/servers/:id/oauth/refresh` (admin)
- `DELETE /api/mcp/servers/:id/oauth` (admin)
- `GET /api/mcp/oauth/callback?code=&state=` (authorization server redirect target, for the service connection and for users' own connections; see [OAuth for remote servers](../product/mcp-server-registry.md#oauth-for-remote-servers))
- `GET /api/mcp/servers/:id/runtime` (builder; breaker state, in-flight and queued calls, refused-call counts; the last failure for admins only)
- `POST /api/mcp/servers/:id/breaker/reset` (admin)
- `GET /api/mcp/servers/:id/connections` (admin; users connected to a delegated server, never tokens)
- `DELETE /api/mcp/servers/:id/connections/:userId` (admin; revoke one user's connection)
- `GET /api/mcp/connections` (operator; your connections to delegated servers in projects where you may run workflows)
- `POST /api/mcp/connections/:serverId/connect` (operator; `{ scope? }` → `{ authorizationUrl, expiresAt, redirectUri }`)
- `DELETE /api/mcp/connections/:serverId` (operator; disconnect your own account)
- Server create and update accept `sandbox`, `limits`, `credentialMode` and `delegatedFallback`; see [Sandboxed stdio servers](../product/mcp-server-registry.md#sandboxed-stdio-servers), [Rate limits, concurrency and the circuit breaker](../product/mcp-server-registry.md#rate-limits-concurrency-and-the-circuit-breaker) and [Delegated credentials](../product/mcp-server-registry.md#delegated-credentials). Gateway calls refused by a limit or an open breaker return JSON-RPC error `-32029` with `data.retryAfterMs`.
- `GET /api/mcp/telemetry?window=24h|7d|30d` (servers configured inline on nodes)
- `GET /api/mcp/servers/:id/resources?projectId=&refresh=` (builder; resources and templates with `access` marks)
- `POST /api/mcp/servers/:id/resources/read` (builder; `{ uri, projectId? }`; 413 over `MCP_RESOURCE_MAX_BYTES`)
- `GET /api/mcp/servers/:id/prompts?projectId=&refresh=` (builder)
- `POST /api/mcp/servers/:id/prompts/get` (builder; `{ name, arguments?, projectId? }`)
- `GET /api/mcp/elicitations?status=&executionId=` (viewer; own runs below operator)
- `GET /api/mcp/elicitations/:id` (viewer)
- `POST /api/mcp/elicitations/:id/answer` (viewer; `{ action: "accept" | "decline" | "cancel", content? }`; 409 once settled)
- Run stream event `mcp_elicitation` (`{ phase: "created" | "settled", elicitation }`) on `POST /api/workflows/:id/execute/stream`

## MCP tool policy

See [MCP tool policy](../product/mcp-tool-policy.md).

- `GET /api/mcp/policies` (builder)
- `POST /api/mcp/policies` (admin; optional `kind` of `tool` | `resource` | `prompt` | `sampling`, see [Rule kinds](../product/mcp-tool-policy.md#rule-kinds); optional `annotationHint`, see [Annotation conditions](../product/mcp-tool-policy.md#annotation-conditions))
- `PUT /api/mcp/policies/:id` (admin)
- `DELETE /api/mcp/policies/:id` (admin)
- `POST /api/mcp/policies/evaluate` (builder; `{ projectId, role, serverId, toolName, kind?, noWriteTools? }`)

## MCP gateway

See [MCP gateway](../product/mcp-gateway.md).

MCP endpoint (client token, `Authorization: Bearer l2m_mcp_...`):

- `POST /mcp/:toolset` (Streamable HTTP, JSON-RPC 2.0: `initialize`, `ping`, `tools/list`, `tools/call`, notifications; JSON or SSE responses)
- `DELETE /mcp/:toolset` (ends the session named by `Mcp-Session-Id`)
- `GET /mcp/:toolset` (405)

Toolsets:

- `GET /api/mcp/toolsets` (builder)
- `POST /api/mcp/toolsets` (admin; `{ name, slug?, description?, projectId?, enabled?, members? }`)
- `GET /api/mcp/toolsets/candidates` (builder; workflows with an Expose as MCP Tool trigger)
- `GET /api/mcp/toolsets/:id` (builder)
- `PUT /api/mcp/toolsets/:id` (admin; `members` replaces the member list)
- `DELETE /api/mcp/toolsets/:id` (admin)
- `GET /api/mcp/toolsets/:id/preview?role=` (builder; tools visible to a role and tools hidden by policy)
- `POST /api/mcp/toolsets/:id/members` (admin; `{ kind: "workflow", workflowId }` or `{ kind: "server", serverId, toolGlob? }`)
- `DELETE /api/mcp/toolsets/:id/members/:memberId` (admin)

Clients:

- `GET /api/mcp/clients` (builder; status, effective role, open sessions, 7-day calls and errors)
- `POST /api/mcp/clients` (admin; `{ name, toolsetIds, role, expiresAt? }`; the response carries the token once)
- `POST /api/mcp/clients/:id/revoke` (admin)
- `GET /api/mcp/clients/:id/usage?window=24h|7d|30d` (builder)

Legacy workflow tool routes (configured on the `mcp_server_trigger` node):

- `GET /api/mcp-server/:path/manifest`
- `POST /api/mcp-server/:path/invoke`

## MCP onboarding

See [MCP onboarding and catalog](../product/mcp-onboarding.md).

- `POST /api/mcp/servers/import` (admin; builders with `dryRun: true`; `{ content, fileName?, dryRun?, projectId?, probe?, entries?: { [key]: { decision?, name?, values? } } }`)
- `GET /api/mcp/presets` (viewer; built-in and approved catalog presets plus the catalog status)
- `GET /api/mcp/catalog` (builder; catalog status, validation errors and entries)
- `POST /api/mcp/catalog/reload` (admin)
- `POST /api/mcp/servers/:id/playground/call` (builder; `{ toolName, args, projectId?, confirmWrite? }`)

## MCP testing

See [Testing MCP workflows](../product/testing-mcp-workflows.md).

- `GET /api/mcp/cassettes?workflowId=&projectId=&evalRunId=&limit=&offset=` (builder; `{ items, total }`, newest first)
- `GET /api/mcp/cassettes/:id` (builder; `{ cassette }` with every recorded call, scrubbed of secrets)
- `GET /api/mcp/cassettes/:id/export` (builder; the `l2m.mcp-cassette` file)
- `DELETE /api/mcp/cassettes/:id` (admin; audit event `mcp_cassette.deleted`)
- `POST /api/executions/:id/replay` (builder; `{ mode?, cassetteId? }` → run result with `executionId` and `mcpReplay: { cassetteId, mode, matched, reused, live, unmatched[] }`; a strict replay with unmatched calls has status `error`)
- `POST /api/eval/runs` gains `record: true` (one cassette per fixture) and `replay: { evalRunId? | cassetteId?, mode? }` (400 when combined with `record`, 404 for an unknown cassette); `GET /api/eval/runs` adds `mcpCassettes`
- `GET /api/mcp/servers/:id/snapshot/export` (builder; the accepted snapshot as an `l2m.mcp-snapshot` file with resources and prompts; 409 before the first snapshot)
- `POST /api/mcp/check` (builder, API keys; `{ serverIds?, toolsetId?, workflowIds?, failOnUnreachable?, failOnPolicyBlocked? }` → `{ ok, checkedAt, servers[], blockedTools[], failures[] }`; probes without storing anything; 404 for unknown servers or toolsets)
- MCP adapter `snapshot_mock` (connection `{ sourceServerId | snapshot, cassetteId?, fixedText? }`) for registry servers that serve a snapshot offline

## Guard

See [Guard in workflows](../product/guard.md). Validation errors are `400 { error, issues: [{ path, message }] }`.

Profiles:

- `GET /api/guard/profiles` (viewer; `{ profiles, autoApply, builtInId }`)
- `POST /api/guard/profiles` (builder; `{ id?, document, note? }`; 409 when the id exists)
- `POST /api/guard/profiles/import` (builder; `{ document }` or `{ text }`; a known id adds a version)
- `GET /api/guard/profiles/:id` (viewer; summary, latest version and bindings)
- `PUT /api/guard/profiles/:id` (builder; `{ document, note? }`; no new version when the hash is unchanged; 409 for the built-in profile)
- `DELETE /api/guard/profiles/:id` (builder; 409 for the built-in profile or while bound)
- `GET /api/guard/profiles/:id/versions` (viewer)
- `GET /api/guard/profiles/:id/versions/:version` (viewer)
- `GET /api/guard/profiles/:id/diff?from=&to=` (viewer; `{ from, to, changes: [{ path, kind, before?, after? }] }`)
- `GET /api/guard/profiles/:id/export?version=` (viewer; the profile JSON with `x-guard-profile-version` and `x-guard-profile-hash` headers)
- `GET /api/guard/detectors` (viewer; registered detectors with tier, channels and categories)

Bindings:

- `GET /api/guard/bindings/projects/:projectId` (viewer; `{ binding, effective }`)
- `PUT /api/guard/bindings/projects/:projectId` (builder; `{ mode: "inherit" | "override" | "enforced", profileId? }`; setting or changing an enforced binding is admin only, 403 otherwise)
- `GET /api/guard/bindings/workflows/:workflowId` (workflow read access; `{ binding, project, effective }`)
- `PUT /api/guard/bindings/workflows/:workflowId` (workflow write access; `{ mode: "inherit" | "override", profileId? }`; `enforced` is 400)
- `GET /api/guard/effective?workflowId=` or `?projectId=` (viewer; the profile stack and the binding chain)

Events (masked evidence only):

- `GET /api/executions/:id/guard-events` (viewer)
- `GET /api/guard/events?projectId=&workflowId=&profileId=&channel=&action=&days=&since=&findings=true&limit=&offset=` (viewer; `{ events, total }`, newest first)
- `GET /api/guard/stats?projectId=&workflowId=&profileId=&days=` (viewer; counts by verdict, action, category, channel and detector, shadow would-block, budget overruns and per-day counts; 14 days by default)

Profile writes and binding changes are audited as `guard.profile.created`, `guard.profile.updated`, `guard.profile.deleted`, `guard.profile.imported` and `guard.binding.updated`.

## Audit bundles

See [Audit bundles and signed run manifests](../security/audit-bundles.md).

- `GET /api/executions/:id/manifest` (read access to the run's workflow; `{ executionId, manifest, digest, keyId, algorithm, signedAt, signature }`; generated once and cached; 409 while the run is in progress)
- `GET /api/executions/:id/bundle` (read access to the run's workflow; streamed zip with `x-l2m-manifest-digest` and `x-l2m-signing-key-id` headers; 409 while in progress, 413 over `AUDIT_BUNDLE_MAX_BYTES`; audited as `execution.audit_bundle.export`)
- `GET /api/audit/signing-keys` (admin; `{ activeKeyId, canRotate, keys: [{ keyId, algorithm, publicKey, publicKeyPem, source, status, createdAt, retiredAt }] }`)
- `POST /api/audit/signing-keys/rotate` (admin; `201 { key, keys }`; 409 when the key comes from `AUDIT_SIGNING_KEY_BASE64`; audited as `audit.signing_key.rotated`)

## Golden runs and replay

See [Golden runs and replay](../product/golden-runs.md).

- `POST /api/replay/recordings` (builder; `{ executionId, name, notes? }`; `201 { recording }`; 409 while the run is in progress, for a replay or over `REPLAY_RECORDINGS_MAX_PER_WORKFLOW`; 413 over `REPLAY_RECORDING_MAX_BYTES`; audited as `replay.recording.created`)
- `GET /api/replay/recordings?workflowId=&limit=&offset=` (viewer; `{ items, total }`)
- `GET /api/replay/recordings/:id` (viewer; `{ recording }` with input, recorded node results and run facts)
- `DELETE /api/replay/recordings/:id` (builder; audited as `replay.recording.deleted`)
- `POST /api/replay/recordings/:id/replay` (builder; `{ draft?, version?, mcpMode?, ignorePaths?, numberTolerance? }`; `{ recordingId, executionId, candidate, status, diff, verdict, reasons, facts }`; audited as `replay.run`)

## Secrets

- `POST /api/secrets` (`{ id, name, provider, projectId, source, warnings }`; `warnings` is non-blocking and never contains the value: it flags a value that equals a word run manifests keep, such as a status)
- `GET /api/secrets`

## Webhooks

- `POST /api/webhooks/execute`
- `ANY /webhook/:path`
- `ANY /webhook-test/:path`

## Helper

- `GET /helper-chat`

## Error response conventions

- `401`: authentication/session errors
- `403`: authorization/signature/replay errors
- `404`: resource not found
- `409`: idempotency conflicts
