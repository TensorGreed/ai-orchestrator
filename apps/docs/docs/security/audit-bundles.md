# Audit bundles and signed run manifests

Every finished run can be exported as an **audit bundle**: a zip holding a signed **run manifest**, the run's node inputs and outputs, its trace and logs, and the files it produced. Anyone with the deployment's public key can check, offline, that nothing in the bundle was changed after L2M signed it.

Everything happens on your own deployment. Signing uses a key that never leaves the server, and verification needs no network access, no hosted service and no timestamping or transparency service.

## The run manifest

The manifest is a versioned JSON document (`format: "l2m.run-manifest"`, `manifestVersion: 1`) built from what the run recorded. It holds:

| Section | What it records |
| --- | --- |
| `run` | Execution id, status, trigger type, who or what started it, start and finish times, duration, error, and digests of the run's input and output |
| `workflow` | Id, name, schema version, workflow version, the saved version whose content matches, node and edge counts, and `hash`: the SHA-256 of the workflow definition's canonical JSON |
| `nodes` | Per node: id, type, name, its config as it ran (secret references only), status, timings, attempts, error category, and digests of its input and output |
| `modelCalls` | Per model call (each agent iteration, or an LLM node): provider, model, parameters such as temperature, tokens in, out and cached, latency and estimated cost |
| `toolCalls` | Per MCP tool call: tool, server (registry id, adapter, identity), schema snapshot hash, digests of the arguments and result, timing, and the outcome: `ok`, `error`, `policy_blocked`, `guard_blocked`, `rate_limited`, `concurrency_limited` or `breaker_rejected` |
| `mcpServers` | The registered servers the run used: adapter, transport, URL without credentials or query, catalog entry and pinned package, snapshot id and hash |
| `prompts` | System and user prompt templates and their rendered text |
| `citations` | Retrieved and cited chunks: marker, source, knowledge base, similarity score, retrieval mode and a digest of the chunk text |
| `approvals` | Approval decisions: who decided, the decision, the reason and when |
| `totals` | Tokens, estimated cost, model calls and tool calls for the whole run |
| `extensions.guard` | Guard verdicts: profile id and version, detector, action, outcome and node, plus counts. No matched content and no evidence |

### What is left out

- **Secret values.** Configs keep `secretRef.secretId` only. Literal values under keys that look like credentials (`apiKey`, `token`, `password`, `authorization` and similar) become `[REDACTED]`, and credentials and query strings are removed from URLs. As a second line of defence, the values of the local secrets the workflow references are scrubbed from the manifest and from every text file in the bundle. Values held in external secret stores are never fetched for this.
- **Payloads.** The manifest holds digests of node inputs and outputs, tool arguments and results, and citation text. The payloads themselves are in the bundle's `execution/nodes/` files, which follow the same redaction as execution history.
- **Guard evidence.** Guard verdicts are summarised without matched content.

### Canonical form and digests

The manifest is serialised as canonical JSON: object keys sorted, no whitespace, `undefined` fields dropped, and non-finite numbers refused. The **manifest digest** is the SHA-256 of those bytes, which are exactly the bytes of `manifest.json` in a bundle. Each digest in the manifest is the SHA-256 of the canonical JSON of the value it describes, so you can recompute any of them from the files in the bundle.

### Generated once, never changed

A manifest is generated the first time someone asks for it (the Runs page, `GET /api/executions/:id/manifest` or a bundle export), then stored and served unchanged. Later exports carry the same `manifest.json` bytes. Runs that are still running, queued or waiting for approval are refused with `409`.

The workflow definition is captured when a run finishes, so `workflow.hash` describes the workflow as it ran (`workflow.source: "captured"`). For runs that finished before this feature, or were cancelled, the manifest uses the stored definition at generation time (`"current"`), or `"unavailable"` when the workflow was deleted.

## Signing keys

Manifests and bundles are signed with Ed25519. The **key id** is the first 16 hex characters of the SHA-256 of the raw 32-byte public key.

- **`AUDIT_SIGNING_KEY_BASE64`** (base64 of a 32-byte seed), when set, is the signing key. Handle it like `SECRET_MASTER_KEY_BASE64`. Generate one with:

  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
  ```

  Rotate it by setting a new value and restarting. The previous key is retired and its public key stays listed.
- **Otherwise** L2M generates a key on first use and stores it encrypted through the secret store as an internal secret. It is hidden from the Secrets page and cannot be referenced by nodes. Admins rotate it from **Settings → Audit Signing** or `POST /api/audit/signing-keys/rotate`; the retired key's private half is deleted and its public key is kept.

The private key never appears in API responses, logs, manifests or bundles. Only key ids and public keys do.

Each manifest records the key that was active when it was generated (`deployment.keyId`). A bundle is signed by the key that is active when it is exported, so after a rotation a new export of an old run is signed by the new key, while bundles exported before still verify with the retired public key.

**Settings → Audit Signing** (admins) shows the active key id and its public key, with copy and download, plus the retired keys. Give the public key to whoever verifies bundles, through a channel they trust.

## The bundle

`GET /api/executions/:id/bundle` returns `l2m-audit-<executionId>.zip`, streamed:

```text
manifest.json              signed run manifest (canonical JSON)
signature.json             signature, key id, public key and the signed index
README.txt                 what is in the bundle and how to verify it
workflow.json              the workflow as it ran; its canonical JSON hashes to manifest.workflow.hash
execution/run.json         the execution record (redacted input, output, status)
execution/nodes/NNN-<id>.json   each node's input and output, in run order
execution/trace.json       node timings, MCP tool-call telemetry, guard events (masked evidence)
execution/logs.jsonl       node activity, errors and warnings, and the run's audit-log entries
outputs/<node>/NN-<name>.<ext>  files the run produced (PDFs, images, documents, CSV and similar)
```

`signature.json` signs an **index**: the execution id, workflow id, the manifest digest, and the path, SHA-256 and size of every file in the bundle except `signature.json` itself. The signature covers the canonical JSON of every field of `signature.json` except `signature`. Changing, adding or removing any file therefore breaks verification.

Response headers `x-l2m-manifest-digest` and `x-l2m-signing-key-id` carry the digest and key id.

Who may export: anyone who can read the run's workflow (viewer and up, subject to project roles). Runs of a deleted workflow are admin-only. Each export is recorded in the audit log as `execution.audit_bundle.export` with the manifest digest and key id; a refused oversize export is recorded with outcome `failure`.

Bundles larger than `AUDIT_BUNDLE_MAX_BYTES` (default 100 MB) are refused with `413`; the manifest is still available.

Stored manifests follow the audit-log retention (`AUDIT_LOG_RETENTION_DAYS`): they are pruned with the audit log. A run whose manifest was pruned gets a new one, with a new signing time, the next time it is asked for, as long as its execution history is still kept.

On the **Runs** page, expanding a finished run shows its signed manifest (digest, signing key, signed-at, workflow version and hash) and an **Audit bundle** button.

## Verifying a bundle offline

The `l2m` command line verifies bundles without contacting any server:

```bash
pnpm l2m audit verify l2m-audit-<id>.zip --public-key audit-key.pub.pem
pnpm l2m audit verify l2m-audit-<id>.zip --public-key MCowBQYDK2VwAyEA… --json
```

`--public-key` takes a file or an inline value: a PEM public key, the base64 of the raw 32-byte key, or the base64 of its DER encoding.

It checks, in order:

1. the zip is well formed: not truncated, no duplicate or unsafe names, every entry's CRC matches;
2. `signature.json` is valid and its key id matches its public key;
3. the given public key has the bundle's key id, and the Ed25519 signature over the index verifies;
4. every file matches its digest and size in the signed index, and no file was added or removed;
5. `manifest.json` hashes to the signed manifest digest and names the same execution and workflow as the index;
6. `workflow.json`, when present, hashes to the manifest's workflow hash.

Without `--public-key` the key embedded in the bundle is used and a note says so: that proves the bundle was not changed after signing, but not who signed it. Always pass the deployment's public key when it matters who signed.

| Exit code | Meaning |
| --- | --- |
| 0 | Every check passed. |
| 1 | A check failed: the bundle was changed, is damaged, or was signed by another key. |
| 2 | Usage error: missing bundle path, unreadable file or a malformed public key. |

`--json` prints `{ ok, keyId, keySource, signedAt, manifestDigest, executionId, workflowId, checks[], warnings[] }`.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `AUDIT_SIGNING_KEY_BASE64` | unset | Base64 of a 32-byte Ed25519 seed. Unset: a key is generated and stored encrypted. |
| `AUDIT_BUNDLE_MAX_BYTES` | `104857600` | Largest bundle the API will build. |
| `AUDIT_LOG_RETENTION_DAYS` | existing | Also prunes stored manifests. |

## API

| Endpoint | Who | Returns |
| --- | --- | --- |
| `GET /api/executions/:id/manifest` | read access to the run's workflow | `{ executionId, manifest, digest, keyId, algorithm, signedAt, signature }`; 409 while in progress |
| `GET /api/executions/:id/bundle` | read access to the run's workflow | the zip; 409 while in progress, 413 over the size cap |
| `GET /api/audit/signing-keys` | admin | `{ activeKeyId, canRotate, keys[] }` with public keys only |
| `POST /api/audit/signing-keys/rotate` | admin | `201 { key, keys }`; 409 when the key comes from `AUDIT_SIGNING_KEY_BASE64` |

The `signature` on the manifest response is an Ed25519 signature over the canonical JSON of `{ format: "l2m.run-manifest-attestation", version: 1, executionId, manifestDigest, keyId, signedAt }`, so a manifest fetched on its own can be checked against the listed public keys too.
