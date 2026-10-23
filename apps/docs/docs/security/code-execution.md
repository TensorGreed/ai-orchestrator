# Code execution and expressions

Workflows run two kinds of user-authored code: **code nodes** (a JavaScript or
Python script in a Code node) and **expressions** (`{{ }}` templates in node
fields and prompts, and the Sort node's key expression). Both run with no
access to the API host.

## Expressions

Every `{{ }}` template and Sort expression is evaluated in an isolated V8 realm
that holds nothing from the API process: no `process`, `require`, `fetch`,
timers, `Buffer`, `WebAssembly`, `SharedArrayBuffer` or file system. Data goes
in and the result comes out as JSON, so the realm never gets a reference to a
host object. Each evaluation has a time limit (`EXPRESSION_TIMEOUT_MS`, default
1000 ms); an expression that loops forever is stopped.

The expression feature set is unchanged: `$input`, `$json`, `$node()`,
`$workflow`, `$execution`, `$vars`, `$env` (a curated subset, never the real
environment), `$now`, `$today`, `$if`, `$ifEmpty` and `$jmespath` all work as
before.

## Code nodes

A Code node runs its script under one of three plans, chosen at startup:

| `CODE_SANDBOX_MODE` | What runs |
|---|---|
| `auto` (default) | A per-execution container when docker or podman is installed **and** both images are already present locally; otherwise the in-process fallback, with a warning logged at startup. |
| `container` | A per-execution container. If no runtime is installed, code nodes fail with a clear error (no silent fallback to the host). |
| `in_process` | Always the in-process fallback on the API host. |

**Container plan.** Each code-node execution runs in a throwaway container
(`--network none --read-only --cap-drop ALL --security-opt no-new-privileges`,
a non-root user, and memory, CPU and process limits), with no host mounts and
no environment passed in. This is the same mechanism as the MCP stdio sandbox.
Set `CODE_SANDBOX_JS_IMAGE` and `CODE_SANDBOX_PYTHON_IMAGE` to pinned images
(a tag or digest, never `latest`) that have `node` / `python3` on `PATH`.

**In-process fallback.** When no container runtime is available:

- **JavaScript** runs in the same kind of isolated realm as expressions — no
  host objects, no network, no file system — with the node's `timeout` as a
  hard limit. Its `input`, `console.*` logs and `return` value behave exactly
  as in the container.
- **Python** runs as a host subprocess in isolated mode (`python -I`) with an
  explicit, minimal environment. The API's own environment —
  `SECRET_MASTER_KEY_BASE64` and every provider key — is never passed to it.
  It still runs as the API user and can read files that user can read, which is
  why the fallback logs a warning at startup. Use the container plan, or
  `CODE_NODES_ENABLED=false`, where that matters.

## Turning code nodes off

Set `CODE_NODES_ENABLED=false` to disable code nodes entirely. Any code node
then fails with a configuration error, and the Code node tester
(`POST /api/code-node/test`) returns `403`.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `CODE_NODES_ENABLED` | `true` | Master switch for code nodes. |
| `CODE_SANDBOX_MODE` | `auto` | `auto`, `container` or `in_process` (see above). |
| `CODE_SANDBOX_RUNTIME` | `auto` | Container CLI: `auto` (docker, then podman), `docker` or `podman`. |
| `CODE_SANDBOX_JS_IMAGE` | `node:22.11.0-alpine3.20` | Image for JavaScript code nodes in container mode. |
| `CODE_SANDBOX_PYTHON_IMAGE` | `python:3.12.7-alpine3.20` | Image for Python code nodes in container mode. |
| `CODE_SANDBOX_MEMORY_MB` | `256` | Container memory ceiling (MB). |
| `CODE_SANDBOX_CPUS` | `1` | Container CPU ceiling (cores). |
| `CODE_SANDBOX_PIDS_LIMIT` | `128` | Container process ceiling. |
| `CODE_SANDBOX_STARTUP_MS` | `8000` | Extra time for a container to start, on top of the code's own timeout (ms). |
| `EXPRESSION_TIMEOUT_MS` | `1000` | Time limit for one `{{ }}` or Sort expression (ms). |
