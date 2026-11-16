---
title: "MCP server can't see API keys or env variables"
sidebarTitle: "Env vars not passed"
description: "Why a local MCP server reports a missing token: the variable was never passed, the client builds a short environment, or a placeholder was not expanded."
level: intermediate
about: stdio-transport
related: [stdio-transport, secret-reference, mcp-server, least-privilege, mcp-client]
---

# MCP server can't see API keys or env variables

A local MCP server that says `GITHUB_TOKEN is not set`, or gets `401 Unauthorized` from the API it wraps, is usually not broken: the variable never reached its process. A server only sees the environment its client builds when it starts it, which is often not your shell's, so put the variable in the server's own `env` entry and restart it.

## What it means

The MCP specification says implementations using the <Term id="stdio-transport">stdio transport</Term> "SHOULD NOT" follow its OAuth-based authorization specification, "and instead retrieve credentials from the environment". So a local server reads its API key from an environment variable, and the <Term id="mcp-client">MCP client</Term> that launches it decides what that environment contains.

An environment is copied once, when a process starts. Three consequences follow:

- A variable you export in a terminal reaches only programs started from that terminal. An app started from a launcher, a service manager or a container never saw it.
- Changing a variable or a config file does not change a server that is already running. The server has to be started again.
- The client chooses whether to pass its own environment at all. Clients differ here, and that difference causes most of these reports.

The official TypeScript SDK shows one common design. Its stdio client does not hand its whole environment to the server. It copies a short list of variables, `HOME`, `LOGNAME`, `PATH`, `SHELL`, `TERM` and `USER` on Linux and macOS and a similar list on Windows, then adds the server's configured `env` on top. A `GITHUB_TOKEN` exported in your shell is therefore not passed unless the server's `env` names it. Other clients may pass their whole environment and merge the server's `env` over it. Either way, the server's `env` entry is the one place that works everywhere.

## Causes (most to least likely)

1. **The variable is not in the server's `env` entry.** It is set in your shell profile or a `.env` file, and the client does not pass those through.
2. **The name is wrong.** The server reads `GITHUB_PERSONAL_ACCESS_TOKEN` and you set `GITHUB_TOKEN`, or the case differs. Names are case-sensitive on Linux and macOS.
3. **A placeholder was not expanded.** Some clients support references such as `${env:NAME}` or prompted inputs, each with their own syntax. If the client does not recognise the form you used, the server receives the literal text `${GITHUB_TOKEN}` as its token, and the remote API answers `401`.
4. **The server is still running with the old environment.** You fixed the config but the client reused the running process.
5. **A container between the client and the server.** With `docker run`, a variable has to reach the container as well as the Docker CLI. Docker's documentation says that for `-e NAME` without a value, "If no `=` is provided and that variable isn't exported in your local environment, the variable is unset in the container."
6. **Secrets kept out of the config and not wired back in.** A team moves keys to a secret store, as it should, but the step that injects them at launch is missing.

## How to check

Ask the server what it received. The echo server in the L2M repository, `samples/mcp-echo-server/server.mjs`, has a `credentials` tool that reports which of `ECHO_API_KEY` and `ECHO_API_SECRET` it received, by name only. Run it with an empty environment plus one variable:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"credentials","arguments":{}}}' \
  | env -i PATH="$PATH" ECHO_API_KEY=abc node samples/mcp-echo-server/server.mjs
```

```text
{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"Received: ECHO_API_KEY"}]}}
```

Register the same server in your client with an `env` entry and call the tool there. If it says `No credentials received`, the client did not pass the variable.

To see what a running server got on Linux, list the names (not the values) of its environment by process id:

```bash
tr '\0' '\n' < /proc/<pid>/environ | cut -d= -f1
```

To see what a short environment does to a variable from your shell:

```bash
env -i PATH=/usr/bin:/bin bash -c 'echo "GITHUB_TOKEN=${GITHUB_TOKEN:-<unset>}"'
```

```text
GITHUB_TOKEN=<unset>
```

Finally, read the server's README for the exact variable names it expects.

## Fix

**Name the variable in the server's entry**, and restart the server or the client:

```json
{
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-github"],
  "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "<token>" }
}
```

**With Docker, pass it twice:** in the client's `env`, so the Docker CLI has it, and as `-e NAME` in the arguments, so the CLI forwards it into the container. Writing `-e NAME=value` in the arguments works too, but puts the value on the command line, where process listings can show it.

**Keep the value out of the file when you can.** A config file with a plaintext token gets copied, synced and committed. OWASP's Secrets Management Cheat Sheet warns that environment variables "are generally accessible to all processes and may be included in logs or system dumps", so they are a delivery mechanism, not storage. Store the token in a secret manager and inject it at launch, give each server its own token with the narrowest scope the API offers, and rotate it if a config file leaked.

**Check the placeholder syntax** in your client's documentation, or replace the placeholder with the value to confirm that the placeholder is the problem.

## If you run agents in L2M

L2M keeps credentials out of the connection JSON. In the [MCP server registry](/product/mcp-server-registry#registering-a-server), a stdio server has a connection with `command`, `args`, `env`, `cwd` and `secretEnvVar`, and an auth secret picked from the secret store, referenced by id (a <Term id="secret-reference">secret reference</Term>):

- **One secret:** set `secretEnvVar` to the variable name, such as `ECHO_API_KEY`, and pick the secret. L2M resolves the secret when it starts the server and sets that one variable. Without `secretEnvVar`, the secret is not injected, and the echo server answers `No credentials received`.
- **Several secrets:** store one secret whose value is a JSON object, such as `{"WAREHOUSE_API_KEY": "…", "WAREHOUSE_API_SECRET": "…"}`, and list the names in `secretEnvVars`. A listed name that is missing from the object is not set. A secret that is not a JSON object stops the call with `MCP server '<name>' lists secret env vars but its secret is not a JSON object of values.`
- **Plain settings** that are not secret go in `env`.

Where the server runs decides what else it gets:

- **On the API host (the default),** the server inherits the API process's whole environment, with `env` and the injected secrets on top. That includes the API's own settings, so a server you do not trust should not run this way.
- **In the optional container sandbox,** the server gets only the variables its config defines plus its secrets, passed to the container by name (`--env NAME`) so the values never appear on a command line. Names the container runtime reads itself, such as `PATH`, `HOME` and `DOCKER_*`, are refused. See [Sandboxed stdio servers](/product/mcp-server-registry#sandboxed-stdio-servers).

The [config importer](/product/mcp-onboarding#how-credentials-are-handled) turns credential-looking values in a client config file into secrets. It cannot read `${env:NAME}` references from the machine the file came from, so it asks you to type those values. It skips `envFile` entries and reports them, so add those values as env vars or secrets yourself. To confirm what a server receives, call a tool from the **Playground** under MCP: the JSON-RPC exchange panel lists the command and the environment variable names, with every credential masked. Secret values are also redacted from tool results there and in gateway responses.

Related errors: [spawn npx ENOENT](/learn/troubleshooting/spawn-npx-enoent) for a `PATH` problem before the server starts, and [MCP error -32000: Connection closed](/learn/troubleshooting/mcp-error-32000-connection-closed) for a server that exits because a variable is missing. [MCP authorization](/learn/mcp/authorization) explains why remote servers use OAuth instead.

## Further reading

- [MCP specification, 2026-07-28: Overview, Auth](https://modelcontextprotocol.io/specification/2026-07-28/basic#auth) (modelcontextprotocol.io)
- [MCP specification, 2026-07-28: stdio transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/stdio) (modelcontextprotocol.io)
- [OWASP Secrets Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html) (owasp.org)
- [Docker: docker container run, environment variables](https://docs.docker.com/reference/cli/docker/container/run/#env) (docs.docker.com)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk) (github.com)
- In L2M: [Secrets](/security/secrets), [MCP onboarding: how credentials are handled](/product/mcp-onboarding#how-credentials-are-handled), [Sandboxed stdio servers](/product/mcp-server-registry#sandboxed-stdio-servers)
