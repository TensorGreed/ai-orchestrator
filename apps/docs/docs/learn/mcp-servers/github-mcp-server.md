---
title: "GitHub MCP server: setup, scopes and safe defaults"
sidebarTitle: "GitHub MCP server"
description: "Connect the open-source GitHub MCP server to an agent with a fine-grained token, read-only toolsets, and approvals before issues, PRs or merges."
level: intermediate
related: [mcp-server, least-privilege, write-tool, secret-reference, mcp-tool-policy, human-in-the-loop]
---

# GitHub MCP server: setup, scopes and safe defaults

The GitHub MCP server (`github/github-mcp-server`) is GitHub's open-source <Term id="mcp-server">MCP server</Term> for repositories, issues, pull requests, Actions and code security. For an agent, the safe setup has three layers: a fine-grained personal access token that only reaches the repositories and permissions the task needs, the server's own `--toolsets` and `--read-only` switches so the model only sees the tools it should use, and a person's approval before any tool that opens an issue, comments, pushes or merges. The token is the real boundary. The switches and approvals narrow what the agent tries.

This guide reflects the server's README and release `v2.1.0` (published 2026-11-03), checked on 2026-11-16.

## Which GitHub MCP server

There are two projects with that name, and only one is maintained:

| Project | Status (2026-11) | How it runs |
|---|---|---|
| `github/github-mcp-server` | Maintained by GitHub. Latest release `v2.1.0`. | Docker image `ghcr.io/github/github-mcp-server`, a Go binary, or GitHub's hosted endpoint |
| `@modelcontextprotocol/server-github` (npm) | Archived. The npm package is marked "Archived and unmaintained; no security guarantees" and its last version is `2025.4.8`. The source moved to `modelcontextprotocol/servers-archived`, whose README says development moved to `github/github-mcp-server`. | `npx` |

Many older tutorials still show `npx -y @modelcontextprotocol/server-github`. Do not use it for new setups. If you start from L2M's built-in **GitHub** preset on the registration form, replace its `npx` command with the Docker command below: the preset still names the archived package.

## Local or remote

The project offers two ways to run it.

- **Local.** You run the server yourself, as a Docker container or a binary built with `go build`, and talk to it over stdio. The README's default Docker image is `ghcr.io/github/github-mcp-server`. You choose the version, the flags and the token, and the server process runs next to your agent runtime.
- **Remote.** GitHub also hosts the server as a remote MCP endpoint. Its README lists the URL and calls it "the easiest method for getting up and running". On the remote endpoint, toolsets and read-only mode are set with request headers (`X-MCP-Toolsets`, `X-MCP-Readonly`) or URL paths (`/x/{toolset}`, `/readonly`) instead of flags. It accepts OAuth or a personal access token, and each host application has to register its own OAuth or GitHub App for the OAuth route.

For a self-hosted agent platform the local server is usually the easier one to govern: the image version is pinned, nothing about the tool list changes until you change the tag, and the configuration lives next to the rest of your deployment. The rest of this guide uses the local server.

## Create a fine-grained token

GitHub recommends fine-grained personal access tokens over classic ones. A fine-grained token belongs to one resource owner (a user or an organization), can be limited to **Only select repositories**, and carries per-area permissions at read or write level. GitHub's own instructions say: "You should choose the minimal repository access that meets your needs" and "You should choose the minimal permissions necessary for your needs."

For an agent that reads code, triages issues and reviews pull requests, without writing:

| Permission | Level | Needed for |
|---|---|---|
| Contents | Read | `get_file_contents`, `search_code`, commits and branches |
| Issues | Read | `issue_read`, `list_issues`, `search_issues` |
| Pull requests | Read | `pull_request_read`, `list_pull_requests` |

Add write levels only for the actions you plan to allow, and know what each one unlocks. GitHub's permission table for the REST API shows, for example, that merging a pull request needs **Contents: write**, not Pull requests: write, and that creating or updating a file needs Contents: write too. So a token with Contents: write can merge, whatever the agent's prompt says.

Three habits from the server's README apply as well: separate tokens per project or environment, regular rotation, and never committing a token. Set an expiry date. If the token belongs to an organization, an organization administrator may have to approve it before it works; GitHub marks it `pending` until then.

## Pick toolsets and turn on read-only mode

The server groups its tools into toolsets. With no configuration it loads the **default** toolsets: `context`, `repos`, `issues`, `pull_requests` and `users`. Other toolsets include `actions`, `code_security`, `dependabot`, `discussions`, `gists`, `git`, `labels`, `notifications`, `orgs`, `projects`, `secret_protection` and `security_advisories`. The special value `all` turns on everything.

Configuration for the local server, as its README and server configuration guide list it:

| Setting | Flag | Environment variable |
|---|---|---|
| Toolsets (an allow-list) | `--toolsets repos,issues` | `GITHUB_TOOLSETS` |
| Individual tools, added to the toolsets | `--tools get_file_contents,issue_read` | `GITHUB_TOOLS` |
| Tools to remove, whatever else is set | `--exclude-tools merge_pull_request` | `GITHUB_EXCLUDE_TOOLS` |
| Read-only mode | `--read-only` | `GITHUB_READ_ONLY` |
| Lockdown mode | `--lockdown-mode` | `GITHUB_LOCKDOWN_MODE` |

The precedence rules matter:

- `GITHUB_TOOLSETS` wins over `--toolsets` when both are set.
- **Read-only wins over everything.** The README says write tools "are skipped if `--read-only` is set, even if explicitly requested via `--tools`".
- **Excluded tools win over toolsets and tools.** `--toolsets pull_requests --exclude-tools create_pull_request,merge_pull_request` gives the agent the pull request read and review tools without the two that open and merge.
- A misspelled tool name stops the server at startup, so a typo fails loudly instead of silently granting less.

**Lockdown mode** is worth a look for agents that read public repositories. With it on, the server checks whether the author of an issue, pull request or comment has push access to the repository, and withholds content from authors who do not. The README is careful to say it is "a best-effort content filter intended to reduce the risk of prompt injection" and "**not** an authorization boundary". It lowers the chance that an agent reads planted instructions; it does not change what the token can do.

A read-only run with the Docker image, pinned to a release:

```bash
docker run -i --rm \
  -e GITHUB_PERSONAL_ACCESS_TOKEN \
  -e GITHUB_TOOLSETS="repos,issues,pull_requests" \
  -e GITHUB_READ_ONLY=1 \
  ghcr.io/github/github-mcp-server:v2.1.0
```

`-e GITHUB_PERSONAL_ACCESS_TOKEN` without a value makes Docker copy the variable from its own environment, so the token never appears on the command line. When the token is set, the server uses it instead of its browser-based OAuth login.

## Which tools write

The server marks every tool with the MCP `readOnlyHint` annotation (in its source, `merge_pull_request` and `issue_write` carry `readOnlyHint: false`). Without `--read-only`, the default toolsets include these write tools among others:

| Tool | What it does |
|---|---|
| `issue_write` | Creates or updates an issue |
| `add_issue_comment` | Comments on an issue or pull request |
| `create_pull_request`, `update_pull_request` | Opens or edits a pull request |
| `merge_pull_request` | Merges a pull request |
| `create_branch`, `create_or_update_file`, `push_files`, `delete_file` | Change repository contents |

Tool names change over time; the README notes that renamed tools keep their old names as aliases. Check the tool list of the version you pin rather than a blog post.

## Attach it to an agent in L2M

In L2M, an agent gets MCP tools from servers in the [MCP server registry](/product/mcp-server-registry) or from MCP Tool nodes on its `tool` port. Register the GitHub server once, as an admin, and every workflow points at the entry.

1. **Store the token as a secret.** Create a secret for the token in the [secrets store](/security/secrets). L2M encrypts it at rest with AES-256-GCM, and the server entry keeps only a <Term id="secret-reference">secret reference</Term>.
2. **Register a stdio server** under **MCP → Servers → + Register server**, with this connection:

```json
{
  "command": "docker",
  "args": [
    "run", "-i", "--rm",
    "-e", "GITHUB_PERSONAL_ACCESS_TOKEN",
    "-e", "GITHUB_TOOLSETS",
    "-e", "GITHUB_READ_ONLY",
    "ghcr.io/github/github-mcp-server:v2.1.0"
  ],
  "env": { "GITHUB_TOOLSETS": "repos,issues,pull_requests", "GITHUB_READ_ONLY": "1" },
  "secretEnvVar": "GITHUB_PERSONAL_ACCESS_TOKEN",
  "timeoutMs": 60000
}
```

   Pick the token secret as the server's auth secret. L2M puts its value into the child process environment under the name in `secretEnvVar`, and `docker run -e` passes it into the container.
3. **Or import a config file.** If your team already has the server in a JSON config from editor settings or a CLI agent, use **Import config** ([importing client config files](/product/mcp-onboarding#import-client-config-files)). The importer treats `GITHUB_PERSONAL_ACCESS_TOKEN` as a credential, stores it as a secret and never writes the value into the connection.
4. **Attach it.** Add an MCP Tool node that points at the registered server to the agent's `tool` port, or list the server in the agent's `mcpServers`.

### Pin the image in the catalog

If your deployment uses a [deployment catalog](/product/mcp-onboarding#deployment-catalog) with `MCP_CATALOG_ENFORCE=true`, admins can only register stdio servers whose command matches an approved entry. For `docker run`, `image:1.4.0` and `image@sha256:…` count as pinned; `image` and `image:latest` do not. A catalog entry for this server:

```json
{
  "id": "github",
  "name": "GitHub (read-only)",
  "adapter": "stdio_mcp",
  "connection": {
    "command": "docker",
    "args": ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN", "-e", "GITHUB_READ_ONLY",
             "ghcr.io/github/github-mcp-server:v2.1.0"],
    "env": { "GITHUB_READ_ONLY": "1" },
    "secretEnvVar": "GITHUB_PERSONAL_ACCESS_TOKEN"
  },
  "requiredSecrets": [{ "name": "GITHUB_PERSONAL_ACCESS_TOKEN", "description": "Fine-grained token, selected repos only" }],
  "approved": true
}
```

A tag can be moved by whoever publishes the image. Pinning by digest (`ghcr.io/github/github-mcp-server:v2.1.0@sha256:…`) fixes the exact bytes; `docker buildx imagetools inspect ghcr.io/github/github-mcp-server:v2.1.0` prints the digest.

### Or let L2M run the container

Instead of `docker run` in the command, an admin can set the server's **Sandbox** to **Container** ([sandboxed stdio servers](/product/mcp-server-registry#sandboxed-stdio-servers)). L2M then starts the command in a throwaway container with a read-only root filesystem, a non-root user, all capabilities dropped and CPU and memory limits, and refuses `latest` or untagged images. Two things to set for this server: networking must be turned on, because it calls the GitHub API, and the image's entrypoint is already the server binary, so the command is the first argument after the image (`stdio`, which is the image's default). This setup is optional; without it the `docker run` connection above works on its own.

## Least privilege in L2M

The token and the toolsets limit what the server can do. L2M's [MCP tool policy](/product/mcp-tool-policy) limits what each workflow and role may call, and all of it is optional: with no rules, every tool is allowed.

- **Read-only workflows.** Turn on **No write tools** for a workflow ([No write tools](/product/mcp-tool-policy#no-write-tools)). Every tool that is not read-only is hidden from its agents. This switch trusts the server's `readOnlyHint`, which this server sends.
- **Approval before writes.** Turn on **Ask before write tools** ([approval before write tools](/product/approvals#approval-before-write-tools)). The agent pauses before every tool an admin has not marked read-only, and a person sees the tool and a preview of its arguments before it runs. This gate ignores the server's own `readOnlyHint`, so mark the read tools you rely on (`get_file_contents`, `issue_read`, `search_code` and so on) as read-only on the server's Tools table, or every call will ask.
- **Rules for the dangerous few.** A `require_approval` rule on tool `merge_pull_request` holds every merge for an admin. A deny rule on `delete_file` removes it outright. Rules can also check arguments ([conditions](/product/mcp-tool-policy#conditions)): deny `issue_write`, then allow it where `owner` equals your organization and `repo` (the repository name, without the owner) is one of your triage repositories, and a call against any other repository fails with a message naming the rule.
- **Writes after untrusted content.** Issue bodies and pull request comments are written by strangers on public repositories. L2M labels tool results as untrusted outside content, and the optional **Approve writes only after untrusted content** switch asks for approval before a write tool once such content is in the agent's context ([untrusted content and write tools](/guides/govern-mcp-tools#untrusted-content-and-write-tools)). This pairs well with the server's lockdown mode.

A reasonable starting point for a triage agent: a token with Issues: write and Contents and Pull requests at read, toolsets `issues,pull_requests,repos`, `--exclude-tools merge_pull_request,push_files,create_or_update_file,delete_file`, and **Ask before write tools** on. The agent can read everything it needs and label or comment only after a person agrees.

See [Least privilege for AI agents](/learn/security/least-privilege-for-agents) for the method behind these layers.

## Test it without a model or a token

Tests that call GitHub need a token in CI and change as the repository changes. L2M can test the agent against a recording instead ([testing MCP workflows](/product/testing-mcp-workflows)):

1. **Record once.** Run the workflow with **Record MCP calls** on. The run's cassette holds every `tools/list` and `tools/call` with arguments and results. The token, credential-looking values and token-shaped strings are replaced with `[REDACTED]` before anything is written.
2. **Mock the server.** Register a server with the **Snapshot mock server** adapter, pointing at the GitHub server's accepted snapshot and the cassette. It serves the same tool schemas with no network access and answers calls from the recording. Point a copy of the workflow at it.
3. **Catch tool changes.** When you bump the image tag, the registry diffs the new tool list against the old one and flags breaking changes. `pnpm l2m mcp check --server <id>` runs the same check in CI and exits non-zero on a breaking change ([`l2m mcp check` in CI](/product/testing-mcp-workflows#l2m-mcp-check-in-ci)).

The [Test MCP servers in CI](/guides/test-mcp-servers-in-ci) guide walks through these steps.

## Try it in L2M

To wire an agent to MCP tools without any token, import the [zero-key MCP agent recipe](/recipes/zero-key-mcp-agent): an agent with the built-in echo model and the mock MCP server. Echo never asks for a tool, so that run only proves the wiring; attach a real chat model to see tool calls. Then register the GitHub server as above and swap it in for the mock server.

To watch a recorded run in which an agent calls tools, open the support agent in the live demo:

<TryInDemo workflow="wf-demo-support-agent" recorded />

## Further reading

- [github/github-mcp-server README](https://github.com/github/github-mcp-server) and its [server configuration guide](https://github.com/github/github-mcp-server/blob/main/docs/server-configuration.md) (GitHub)
- [Managing your personal access tokens](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens) (GitHub Docs)
- [Permissions required for fine-grained personal access tokens](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens) (GitHub Docs)
- [Archived reference servers](https://github.com/modelcontextprotocol/servers-archived) (modelcontextprotocol)
- In L2M: [MCP server registry](/product/mcp-server-registry), [MCP onboarding and catalog](/product/mcp-onboarding), [MCP tool policy](/product/mcp-tool-policy), [Approval gates](/product/approvals), [Secrets](/security/secrets)
- Concepts: [MCP tool annotations](/learn/mcp/tool-annotations), [Least privilege for AI agents](/learn/security/least-privilege-for-agents)
