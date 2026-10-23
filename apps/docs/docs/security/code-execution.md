# Code execution and expressions

Workflows run two kinds of user-authored code: **code nodes** (a JavaScript or
Python script in a Code node) and **expressions** (`{{ }}` templates in node
fields and prompts, and the Sort node's key expression). This page says what
each one can and cannot reach. One case is **not** sandboxed: Python code
nodes running on the host. See [Python on the host](#python-on-the-host).

## Expressions

Every `{{ }}` template and Sort expression runs in
[QuickJS](https://bellard.org/quickjs/) compiled to WebAssembly, inside the API
process. That is a separate JavaScript engine with its own heap inside a
WebAssembly instance, not a context of the API's own V8 engine. It holds no
object or function from the API process: no `process`, `require`, `fetch`,
timers, `Buffer`, file system or network, and no host error object either.
Errors were the way out of the earlier `node:vm` realm. Data goes in and the
result comes out as JSON.

Each evaluation gets a **fresh** QuickJS runtime and context, which is thrown
away afterwards. Nothing one evaluation does (a patched prototype, a global, a
hooked iterator) is visible to the next. The expressions in one template share
a context, because they share an author and data; each still re-reads its own
copy of the data. Every evaluation is bounded:

| Limit | Setting |
|---|---|
| Time | `EXPRESSION_TIMEOUT_MS` (default 1000 ms) per expression. Covers loops and catastrophic regular expressions. |
| Template budget | `EXPRESSION_TEMPLATE_BUDGET_MS` (default 5000 ms) for all the expressions of one template together, so a field with hundreds of slow `{{ }}` cannot hold the API for hundreds of seconds. A single expression always gets at least `EXPRESSION_TIMEOUT_MS`. |
| Memory | `EXPRESSION_MEMORY_MB` (default 64 MB). Both one large allocation and many small ones fail with `out of memory` inside the sandbox instead of growing the API's memory. |
| Result size | `EXPRESSION_MAX_RESULT_MB` (default 8 MB, as JSON). A larger result is an error. |
| Stack | A fixed 192 KB QuickJS stack. Deep recursion is a catchable `stack overflow`. |

QuickJS's own allocation limit misses much of what many small strings cost, so
the sandbox also measures the WebAssembly instance's memory while the code runs
and stops it once that has grown by more than the limit. WebAssembly memory
never shrinks: an instance that has grown past 256 MB (or past the largest
memory limit in use, if that is higher) is replaced by a fresh one after the
session, which releases the memory.

An expression that throws or times out renders as an empty value, as it always
has. A failure of the **sandbox itself** never does: the node fails with an
`expression sandbox error` instead, so an IF or Switch node never branches on
a value that silently lost its expression, and an empty value never reaches a
URL, request body or prompt. That covers three cases:

- **An instance crashed on this expression.** Some inputs, such as a result
  nested thousands of levels deep or source nested tens of thousands of
  levels deep, exhaust the host's native stack inside the WebAssembly call
  before QuickJS's own check fires. The instance is retired and a pre-loaded
  spare takes over, so other evaluations keep working. This error is not
  retryable.
- **No instance was ready.** Four spares are kept loaded, and new ones load in
  the background in a few milliseconds. If they ever run out, the error is
  marked retryable: run the workflow again or enable Retry on Fail on the node.
- **The workflow's circuit breaker is open.** A workflow (or, for the
  expression preview and the Code node tester, a user) whose code retires
  three instances within a minute has its expressions and in-process code
  refused for five minutes. The refusal does not touch the shared pool, so one
  author cannot keep it empty for everyone else.

The expression feature set is unchanged: `$input`, `$json`, `$node()`,
`$workflow`, `$execution`, `$vars`, `$env` (a curated subset, never the real
environment), `$now`, `$today`, `$if`, `$ifEmpty` and `$jmespath` all work as
before. Differences from the earlier V8-based evaluator:

- There is no `Intl`. `toLocaleString()` and `localeCompare()` exist but are
  not locale-aware.
- Error messages come from QuickJS, so their wording differs: for example
  `'x' is not defined` rather than `x is not defined`.
- Recursion depth is lower: about a thousand frames rather than about ten
  thousand.

## Code nodes

A Code node runs its script under one of three plans, chosen at startup:

| `CODE_SANDBOX_MODE` | What runs |
|---|---|
| `auto` (default) | A per-execution container when docker or podman is installed **and** both images are already present locally; otherwise the in-process fallback, with a warning logged at startup. |
| `container` | A per-execution container. If no runtime is installed, code nodes fail with a clear error (no silent fallback to the host). |
| `in_process` | Always the in-process fallback on the API host. |

The API settles the plan before it accepts requests. Until then, and whenever
the plan cannot be determined, code nodes are refused rather than run on the
host.

**Container plan (preferred).** Each code-node execution runs in a throwaway
container (`--network none --read-only --cap-drop ALL --security-opt
no-new-privileges`, a non-root user, and memory, CPU and process limits), with
no host mounts and no environment passed in. This is the same mechanism as the
MCP stdio sandbox. Set `CODE_SANDBOX_JS_IMAGE` and `CODE_SANDBOX_PYTHON_IMAGE`
to pinned images (a tag or digest, never `latest`) that have `node` /
`python3` on `PATH`.

### JavaScript in process

JavaScript runs in the same QuickJS WebAssembly sandbox as expressions, with
one fresh runtime per input item. It is bounded by:

- the node's `timeout`, clamped to `CODE_SANDBOX_MAX_TIMEOUT_MS` (default
  30000 ms). A node set to run once per item may not exceed four times that
  for all its items together; such a node is refused before it starts;
- `CODE_SANDBOX_MEMORY_MB` (default 256 MB), measured the same way as for
  expressions;
- `CODE_SANDBOX_MAX_RESULT_MB` (default 32 MB) for the results and logs of all
  the node's items together;
- the same stack limit.

`input`, `console.*` logs, `await` and the `return` value behave as in the
container. One difference: the container runs on Node (V8, with `Intl`), while
in-process runs on QuickJS (no `Intl`).

::: warning In-process JavaScript blocks the API while it runs
QuickJS runs synchronously on the API's event loop, so while an in-process
code node runs, the API serves no other request. The timeout ceiling is what
bounds that: with the defaults, one node can hold the API for up to 30 s, and a
per-item node for up to 120 s. Lower `CODE_SANDBOX_MAX_TIMEOUT_MS` if code
nodes are short, or use the container plan, which runs code in another
process. Moving in-process code into a worker thread was considered; it is not
done in this release.
:::

### Python on the host

::: danger Not a sandbox
Without a container, a Python code node runs as a **host subprocess**. It gets
`python -I` (isolated mode), an explicit minimal environment (the API's own
variables are not passed in), a scratch working directory, and a hard kill of
its process group on timeout. A process the code detaches with `setsid` leaves
that group and survives the kill; the run itself still finishes when Python
exits. None of that is isolation. Anyone who can author
a workflow can make it:

- run any OS command as the API user;
- open network connections to anything the host can reach. The
  [outbound URL guard](./outbound-url-guard.md) does not apply to it;
- read any file the API user can read, including the SQLite database and a
  `.env` file;
- **read the API's own environment on Linux** through
  `/proc/<api-pid>/environ`. That file holds the environment the API was
  started with, including `SECRET_MASTER_KEY_BASE64` when it is set as an
  environment variable. With that key, every stored secret can be decrypted.
  This was verified on Linux 6.17 with `kernel.yama.ptrace_scope=1`: Yama
  blocks reading the API's memory (`/proc/<pid>/mem`) but not its `environ`.
:::

What you can do about it, from strongest to weakest:

1. **Use the container plan.** Install docker or podman and pull the two
   images (`CODE_SANDBOX_MODE=container`). Python then runs with no network,
   no host files and no environment.
2. **Turn host Python off** with `CODE_SANDBOX_PYTHON_IN_PROCESS=deny`. Python
   code nodes fail with a clear error, and JavaScript keeps working in the
   QuickJS sandbox.
3. **Run host Python as another user** with `CODE_SANDBOX_PYTHON_UID` and
   `CODE_SANDBOX_PYTHON_GID`, for example the `nobody` user (65534). A
   different uid cannot read the API's `/proc` entries or files only the API
   user can read. It can still run commands, use the network and read
   world-readable files, so check the permissions on the database and `.env`.
   This needs the API to hold `CAP_SETUID`, `CAP_SETGID` and `CAP_CHOWN` (for
   example, running as root inside a container); otherwise Python code nodes
   fail with a configuration error that names the missing capabilities. When
   only the uid is set, the gid defaults to the same number, so the child does
   not keep the API's primary group. A dedicated uid also lets an operator
   kill anything host Python left behind (`pkill -u <uid>`), including
   processes it detached with `setsid`.
4. **Know where the key is visible.** `/proc/<pid>/environ` shows the
   environment the API process was started with (docker `-e`, systemd
   `Environment=`, a shell `export`). Removing the variable later does not
   change what it shows. A key that the API reads from `.env` at startup is not
   in that file, but `.env` itself is readable by the same user. With the
   default settings, assume host Python can read the master key either way.

Linux namespace tools (bubblewrap, `unshare`) would also hide the API's
processes and network from host Python. Many distributions block them for
unprivileged users (Ubuntu's `kernel.apparmor_restrict_unprivileged_userns`),
so the API does not depend on them.

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
| `CODE_SANDBOX_MEMORY_MB` | `256` | Container memory ceiling, and the heap limit of one in-process JavaScript run (MB). |
| `CODE_SANDBOX_CPUS` | `1` | Container CPU ceiling (cores). |
| `CODE_SANDBOX_PIDS_LIMIT` | `128` | Container process ceiling. |
| `CODE_SANDBOX_STARTUP_MS` | `8000` | Extra time for a container to start, on top of the code's own timeout (ms). |
| `CODE_SANDBOX_PYTHON_IN_PROCESS` | `allow` | `deny` refuses Python code nodes when there is no container plan. |
| `CODE_SANDBOX_PYTHON_UID` / `CODE_SANDBOX_PYTHON_GID` | unset | Run host Python as this uid / gid (the gid defaults to the uid). |
| `CODE_SANDBOX_MAX_TIMEOUT_MS` | `30000` | Ceiling on an in-process JavaScript code node's timeout (100 to 300000 ms); a per-item node may not exceed four times it in all. |
| `CODE_SANDBOX_MAX_RESULT_MB` | `32` | Largest result (results and logs of all items) an in-process JavaScript code node may return (MB). |
| `EXPRESSION_TIMEOUT_MS` | `1000` | Time limit for one `{{ }}` or Sort expression (ms). |
| `EXPRESSION_TEMPLATE_BUDGET_MS` | `5000` | Time budget for all the expressions of one template together (ms). |
| `EXPRESSION_MEMORY_MB` | `64` | Memory limit for one expression evaluation (MB). |
| `EXPRESSION_MAX_RESULT_MB` | `8` | Largest result one expression may return (MB, as JSON). |
