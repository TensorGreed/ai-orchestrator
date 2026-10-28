# API Endpoints

## Auth

- `POST /api/auth/register`
- `POST /api/auth/login`
- `POST /api/auth/logout`
- `GET /api/auth/me`
- `GET /api/auth/oidc/metadata` (public; `{ "enabled": false }` when OIDC is off; see [OIDC single sign-on](../security/auth-rbac.md#oidc-single-sign-on))
- `GET /api/auth/oidc/login` (browser navigation; redirects to the IdP)
- `GET /api/auth/oidc/callback?code=&state=` (IdP redirect target; redirects to the web app)

## Workflows

- `GET /api/workflows`
- `GET /api/workflows/:id`
- `POST /api/workflows`
- `PUT /api/workflows/:id`
- `DELETE /api/workflows/:id` (while the workflow's release gate is on and enforced, only an admin: others get `403`, audited as `release.workflow_delete.refused`)
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
- `POST /api/replay/estimate` (builder) takes a replay job request and answers what it would run and cost (`{ cases, runsPerCase, modelCallsEstimate, estimatedCostUsd, costUnknown, warnings }`) without running it; replay jobs take workflow files, overrides, model calls from the tape, baseline reruns and repeats. See [Candidates and comparison](../product/golden-sets.md#candidates-and-comparison)
- `POST /api/eval/runs` answers `202 { run, runId }` and runs in the background (`?wait=true` keeps the old blocking `200` for one release); golden sets, replay jobs and scorers are in [Golden sets and replay jobs](../product/golden-sets.md)
- `POST /api/eval/runs` gains `record: true` (one cassette per fixture) and `replay: { evalRunId? | cassetteId?, mode? }` (400 when combined with `record`, 404 for a cassette or eval run whose workflow you cannot read); `GET /api/eval/runs` adds `mcpCassettes`
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

- `POST /api/replay/recordings` (builder; `{ executionId, name, notes? }`; `201 { recording }`; 409 while the run is in progress, for a replay, for a run already saved (`code: "duplicate"`) or over `REPLAY_RECORDINGS_MAX_PER_WORKFLOW`, `REPLAY_RECORDINGS_MAX_BYTES_PER_WORKFLOW` or `REPLAY_RECORDINGS_MAX_TOTAL_BYTES`; 413 over `REPLAY_RECORDING_MAX_BYTES`; audited as `replay.recording.created`)
- `GET /api/replay/recordings?workflowId=&limit=&offset=` (viewer; `{ items, total }`)
- `GET /api/replay/recordings/:id` (viewer; `{ recording }` with input, recorded node results and run facts)
- `DELETE /api/replay/recordings/:id` (builder; `403` to a builder for a golden run an admitted case of a gate that is on and enforced replays; audited as `replay.recording.deleted`)
- `POST /api/replay/recordings/:id/replay` (builder; `{ draft?, version?, mcpMode?, ignorePaths? (up to 32, 128 characters, eight ** each), numberTolerance? }`; a version runs under the workflow's current project; `{ recordingId, executionId, candidate, status, diff, verdict, reasons, facts }`; audited as `replay.run`)
- Production capture (Phase 15.6): `GET`/`PUT /api/workflows/:id/replay-capture`, `GET /api/workflows/:id/replay-captures`, `POST /api/replay/captures/:id/promote`, `POST /api/replay/captures/promote`, `DELETE /api/replay/captures/:id`, `POST /api/replay/captures/discard`, and the admin data-subject lookup `POST /api/replay/recordings/find-subject` (`{ value, dataClass?, country? }`, search only; each match is `exact` or a `national_only` possible match) and `POST /api/replay/recordings/find-subject/delete` (deletes the ids a search returned; a possible match only with `confirmPossible: true`). The inbox's `trigger=api_key` lists runs an API key started. See [Production capture](../product/production-capture.md#api). Captured runs (`status: "candidate"`) are left out of `GET /api/replay/recordings`; replaying one or adding it to a golden set answers 409.

## Releases

See [Release gate and publish](../product/release-gate.md). Every route answers `404` for a workflow the user cannot read and `403` when they may not act on it.

- `GET /api/workflows/:id/release-gate` (viewer; `{ gate }`)
- `PUT /api/workflows/:id/release-gate` (`workflow:write`; only admins enforce a gate, lift enforcement or loosen an enforced one; `400` for a golden set of another workflow; audited as `release.gate.updated`)
- `POST /api/workflows/:id/publish` (`workflow:publish`; `{ version, workflowHash?, replayRunId?, override?: { reason } (admins), requestApproval?: { reason } }`; `200 { release }`, `202 { verdict: "needs_approval", approvalRequestId }`, `409 { verdict: "blocked", reasons, replayRunId?, canRequestApproval }`; `409` for a hash mismatch; audited as `release.published`, `release.overridden` or `release.blocked`)
- `GET /api/workflows/:id/releases` (viewer; `{ releases, publishedVersion }`)
- `POST /api/workflows/:id/rollback` (`workflow:publish`, and, while the gate is on and enforced, only an admin (others get `403`, audited as `release.rollback.refused`); `{ version, reason }`; only to a version published before; `409` when it is already live; audited as `release.rolled_back`)
- `POST /api/workflows/:id/unpublish` (`workflow:publish`, and an admin while the gate is on and enforced (`403` otherwise, audited as `release.unpublish.refused`); `{ reason?, expectedVersion? }`; production runs the draft until a version is published again; never blocked by the release gate, and with a gate on `notice` says production runs the ungated draft; answers `{ release, productionRuns: "draft", gateEnabled, gateEnforced, notice }` where `release` is the `unpublished` history entry; `409` when nothing is published or, given `expectedVersion`, when another version is live (nothing changes); audited as `release.unpublished`)
- `GET /api/workflows/:id/release-state`, `GET /api/workflows/:id/publish-preview?version=` (viewer)
- `GET /api/workflows/:id/release-gate/cases` (viewer; an enforced gate's cases: admitted or pending admission, required; `enforced: false` and no cases otherwise; `enabled` says whether the gate is switched on, since admission and required cases apply only then)
- `POST /api/workflows/:id/release-gate/cases/admit`, `POST /api/workflows/:id/release-gate/cases/reject` (admins; `{ fixtureIds, reason? }`; `409` on an unenforced gate, or when rejecting an admitted case; audited as `release.gate.cases_admitted` / `release.gate.cases_rejected`)
- `PUT /api/workflows/:id/release-gate/cases/:fixtureId/required` (admins; `{ required }`; golden-run cases only; marking a pending case admits it; audited as `release.gate.case_required`)
- `POST /api/workflows/:id/release-gate/cases/requests` (`workflow:write`; `{ action: "admit" | "remove", fixtureIds, reason }`; `202 { request }`; admit only pending cases, remove only admitted ones (`409` otherwise); audited as `release.gate.case_request.requested`)
- `PUT /api/workflows/:id/release-gate` takes `admitAddedSetCases: true` (admins; `403` otherwise) to admit the cases of the golden sets the save adds to an enforced gate; without it they wait for admission
- `DELETE /api/eval/fixtures/:id` and `DELETE /api/eval/datasets/:id` answer `403` to a builder for an admitted case, or a golden set, of a gate that is on and enforced (a gate switched off restricts neither); an admin's delete of admitted cases (and of a golden run they replay, or the workflow) is audited as `release.gate.cases_removed`
- `GET /api/replay/runs/:id` carries `releaseGate: { enforced, admittedFixtureIds, pendingFixtureIds, requiredFixtureIds, requiredCaseNames, errorsCountAsFailures, verdict, reasons }` when the workflow's enforced gate uses one of the job's golden sets (`verdict`: how the gate judges the job's case results now)

## Approvals

See [Approval gates](../product/approvals.md). Release requests (Phase 15.4) appear in the same list with `kind: "release"` and an `id` starting `rar_`; deciding one publishes the version (`{ request, release }`). Requests to admit cases to an enforced release gate, or remove admitted ones, appear with `kind: "admit_cases"` or `"remove_cases"` and an `id` starting `gcr_`; deciding one answers `{ request }`, against the gate's current approvers, and `409` when the request went stale (the gate's approvers, self-approval or enforcement changed after it was made). Approving a release request judges the version again and answers `409` with `details.reasons` when the gate now blocks it for a new kind of reason or a worse measure of one it had. A filter by `executionId` lists neither.

- `GET /api/approvals?status=pending|decided|all&workflowId=&executionId=&limit=` (viewer; `{ items }` limited to workflows the user can read, filtered before the limit; `404` when `workflowId` or `executionId` names a workflow or run the user cannot read, or one that does not exist; each item has `requestId`, `id` (the execution id), `kind`, `status`, `message`, approvers, `editableFields` with proposed values, `path`, `expiresAt`, the decision fields and `canDecide` / `cannotDecideReason`)
- `POST /api/approvals/:id/approve` (`:id` is the execution id; `{ reason?, edits?, requestId? }`; needs execute access to the workflow's project (and to every workflow along a sub-workflow path) and a matching approver; `200` with the run result, `202 { queued: true }` with the execution queue, `400` for invalid edits (`details: [{ key, message }]`), `403` for self-approval, a non-approver or no project access, `404` when nothing is pending or the run is not visible (checked first), `409` when already decided, expired, or `requestId` is not the current request, `503` when the resume could not start (the request is pending again; decide again); audited as `approval.decided`)
- `POST /api/approvals/:id/reject` (`{ reason?, requestId? }`; the reason is required for Approval Gates that require one and for write-tool approvals; same responses)
- `POST /api/approvals/eligibility` (builder; `{ workflowId, projectId?, approverRoles?, approverUsers?, allowSelfApproval? }` → `{ othersCanApprove, requesterCanApprove }`; `404` for a workflow (or, unsaved, a project) the user cannot read, `403` without edit access: whether anyone but the signed-in user, and whether the signed-in user, could approve a run they start with these settings; the editor warns from it)
- `PUT /api/workflows/:id/pins/:nodeId` answers `400` for an Approval Gate; `/api/workflows/:id/execute` and `/api/executions/:id/retry` refuse a `startNodeId` or single-node run below an Approval Gate, and ignore pinned or seeded output for a gate.

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
