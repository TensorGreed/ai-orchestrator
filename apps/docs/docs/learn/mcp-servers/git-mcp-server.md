---
title: "Git MCP server: give an agent read access to a repo"
sidebarTitle: "Git MCP server"
description: "Run the reference git MCP server under an agent: read-only tools first, which tools write, and how to keep an agent from committing without approval."
level: intermediate
related: [mcp-server, write-tool, tool-annotations, approval-gate, human-in-the-loop, mcp-tool-policy]
---

# Git MCP server: read access for an agent

The reference git MCP server lets an agent read a repository (status, diffs, log, branches, file contents at a revision) and also change it (stage, commit, reset, branch, checkout, merge). It has no read-only mode of its own, so the safe setup is: confine it to one repository with `--repository`, let the agent use the eight read tools freely, and either block the six write tools or require a person's approval before them. It has no push tool, so nothing leaves the machine through it.

## What the server is

`mcp-server-git` is a Python server in the `modelcontextprotocol/servers` repository, under `src/git`. As of November 2026 it is an active reference server. The `modelcontextprotocol/servers-archived` repository also holds a `src/git` folder, but that is an unmaintained copy last changed in April 2025; use the one in `modelcontextprotocol/servers`. Its latest release on PyPI is 2026.11.11, and its README still describes it as "in early development", with tools that may change. It needs Python 3.10 or later and Git 2.31 or later, speaks <Term id="stdio-transport">stdio</Term>, and serves both 2025-11-25 clients (`initialize`) and 2026-07-28 clients (`server/discover`).

Run it with `uvx`, pinned:

```bash
uvx mcp-server-git==2026.11.11 --repository /srv/repos/handbook
```

Or install it with `pip install mcp-server-git` and run `python -m mcp_server_git --repository /srv/repos/handbook`. The README also has a Docker build (`mcp/git`) for container use. To look at the tools by hand, the README suggests the MCP Inspector: `npx @modelcontextprotocol/inspector uvx mcp-server-git`.

## Which tools read and which write

The README lists fourteen tools. The server's source sets <Term id="tool-annotations">tool annotations</Term> on each of them, and every tool sets `openWorldHint: false`:

| Tool | Reads or writes | `destructiveHint` | `idempotentHint` |
|---|---|---|---|
| `git_status`, `git_diff_unstaged`, `git_diff_staged`, `git_diff`, `git_log`, `git_show`, `git_branch`, `git_remote` | read (`readOnlyHint: true`) | `false` | `true` |
| `git_add` | write: stages files; `["."]` stages everything | `false` | `true` |
| `git_commit` | write: commits what is staged, or concludes a merge in progress | `false` | `false` |
| `git_reset` | write: unstages all staged changes | `true` | `true` |
| `git_create_branch` | write | `false` | `false` |
| `git_checkout` | write: switches branches, or detaches HEAD at a SHA or tag | `false` | `false` |
| `git_merge` | write: fast-forward only by default | `false` | `true` |

Some details worth knowing before you hand it to an agent:

- **No push, fetch or clone.** The server works on repositories that are already on disk. The changes an agent makes stay local until someone pushes them.
- **`git_remote` hides credentials.** A token embedded in a remote URL is shown as `<redacted>`.
- **`git_merge` cleans up after itself.** It refuses a dirty working tree or a detached HEAD, and a merge that stops on conflicts is aborted, so the repository is left as it was.
- **Two prompts.** `git_commit_message` and `git_summarize_changes` return a user message with the staged diff or the changes embedded, ready to send to a model.

## Confine it to one repository

Every tool takes a `repo_path` argument. The README's warning is direct: "Without `--repository`, the server reads and writes any Git repository the server process can reach." That includes the write tools. `--repository` (or `-r`) is the only confinement the server offers. It never asks the client for MCP roots, in either protocol era, and L2M does not declare the roots capability anyway. So the argument in the server's connection is the whole boundary.

Three points about how it works:

- `--repository` admits the **whole enclosing repository**. `--repository /srv/repos/handbook/docs` allows calls anywhere in `/srv/repos/handbook`.
- With `--repository` set, the server refuses repositories that use alternate object stores, repositories whose Git directory holds a symbolic link leading outside, and nested repositories whose `.git` file points elsewhere.
- The server never runs programs named by a repository's own configuration or hooks: no hooks, no external diff or textconv drivers, no filter or merge drivers defined by the repository. That protects you when an agent reads a repository someone else prepared.

These protections have been fixed and tightened through published advisories. The most serious recent one, GHSA-6hqx-gqrx-c5r2 (rated high, published 2026-11-11), was arbitrary command execution through a repository's own Git configuration during read-only tools, fixed in 2026.11.11. Two confinement bypasses, GHSA-w766-5x43-whvw and GHSA-q74p-4wrc-q7w6, were fixed in 2026.10.28 and 2026.11.11. Pin 2026.11.11 or later.

## Give commits an identity

`git_commit` takes the author and committer from `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME` and `GIT_COMMITTER_EMAIL`, then from Git config. If neither is set, it does not refuse: it falls back to the operating-system user and host name. On a server or in a container that produces commits like `app <app@3f2a1b9c8d7e>`. Set all four variables so agent commits are easy to recognise:

```json
{
  "command": "uvx",
  "args": ["mcp-server-git==2026.11.11", "--repository", "/srv/repos/handbook"],
  "env": {
    "GIT_AUTHOR_NAME": "Handbook agent",
    "GIT_AUTHOR_EMAIL": "handbook-agent@example.com",
    "GIT_COMMITTER_NAME": "Handbook agent",
    "GIT_COMMITTER_EMAIL": "handbook-agent@example.com"
  },
  "timeoutMs": 60000
}
```

## Run it in L2M

That JSON is a `stdio_mcp` connection for the [MCP server registry](/product/mcp-server-registry). Register it under **MCP → Servers**:

- **From the Git preset.** The preset on the registration form fills in `uvx mcp-server-git==2026.11.11 --repository /path/to/repo`. Replace the path, and add the `env` block above. `uvx` and `git` have to be installed on the API host; the stock L2M container image includes both.
- **From your catalog.** A [deployment catalog](/product/mcp-onboarding#deployment-catalog) entry pins `mcp-server-git==2026.11.11` the way the catalog expects for `uvx`. With `MCP_CATALOG_ENFORCE=true`, only that pinned package can be registered; the `--repository` path after it stays free.
- **From a config file.** If the server is already in a client config, use [Import config](/learn/mcp-servers/import-mcp-json-config).

The repository must exist on the API host, because a stdio server runs there with the API's permissions. If an admin sets the server's **Sandbox** to **Container** ([sandboxed stdio servers](/product/mcp-server-registry#sandboxed-stdio-servers)), the command runs in a throwaway container with no network, so use an image that already contains the server. Mount the repository from under `MCP_SANDBOX_ALLOWED_MOUNT_ROOTS`; a mount is read-only unless you tick **Writable**. A read-only mount is a second, operating-system-level guarantee that the agent cannot change the repository.

Attach the server to an agent through an MCP Tool node on its `tool` port, or the agent's server list. To use the server's `git_summarize_changes` prompt, see [using a server prompt](/product/mcp-server-registry#using-a-server-prompt).

## Keep the agent from committing without approval

Everything here is optional, and you pick the strength you need. With no settings, every tool is allowed.

**Read access only.** For a reviewer or a "what changed this week" agent, block the writes:

- a tool policy deny rule on this server with the annotation condition **not_read_only** ([annotation conditions](/product/mcp-tool-policy#annotation-conditions)), or
- the workflow's **No write tools** switch ([No write tools](/product/mcp-tool-policy#no-write-tools)).

Both use the server's annotations unless an admin marked a tool by hand, and the server annotates every tool, so the six write tools disappear from the agent's tool set. A model that asks for one by name gets a tool error instead of a result.

**Writes with a person's approval.** For an agent that drafts changes:

- A `require_approval` rule with pattern `git_commit` on this server ([require approval](/product/mcp-tool-policy#require-approval)). Add rules for `git_reset`, `git_checkout` and `git_merge` if those matter to you, or use one rule with the annotation condition **not_read_only** to cover all six.
- Or the workflow's **Ask before write tools** switch ([approval before write tools](/product/approvals#approval-before-write-tools)). This gate ignores the server's `readOnlyHint` and trusts only an admin's marks, so mark the eight read tools **read-only** on the server's Tools table first, or every `git_status` pauses too.

When the agent reaches `git_commit`, the run pauses and the request shows the tool, the server and the arguments, here `repo_path` and the commit message. It does not show the diff. Two habits fill that gap: tell the agent in its instructions to call `git_diff_staged` before it commits and to include the result in its answer, and have the approver look at the staged changes in the repository. The approval covers that one call with those exact arguments; a second commit asks again.

A safety net that needs no setting: after a broken connection or a crashed server process, L2M sends a tool call again only when the tool is read-only or idempotent. `git_commit` is neither, so a commit whose outcome is unknown fails as `outcome_unknown` instead of being made twice.

## Test it without a repository

Turn on **Record MCP calls** and run the workflow once: every git call, with its arguments and result, is stored as a <Term id="cassette">cassette</Term>. A strict **Replay** answers each call from the cassette and never starts the server, so you can change the prompt and check the agent still calls `git_diff_staged` before `git_commit`. For CI, export the server's accepted snapshot and serve it as a <Term id="snapshot-mock">snapshot mock</Term> over stdio:

```bash
pnpm l2m mcp snapshot export --server mcp_123 --out git.snapshot.json
pnpm l2m mcp mock --snapshot git.snapshot.json --cassette run.cassette.json
```

`l2m mcp check` then fails the build if a new server release removes or renames a tool or makes a breaking change to its arguments (a removed or newly required argument, a narrowed type). Given the README's "early development" note, that check earns its place. [Test MCP servers in CI](/guides/test-mcp-servers-in-ci) has the steps.

## Try it in L2M

The [zero-key MCP agent recipe](/recipes/zero-key-mcp-agent) runs an agent with no API key against the built-in mock server, which marks `get_current_time` read-only and leaves `calculator` unannotated, so `calculator` counts as a write tool. Turn on **No write tools** there to see a write tool hidden, then register the git server and apply the same rule to it.

## Further reading

- [mcp-server-git README](https://github.com/modelcontextprotocol/servers/blob/main/src/git/README.md) (modelcontextprotocol/servers on GitHub)
- [GHSA-6hqx-gqrx-c5r2](https://github.com/modelcontextprotocol/servers/security/advisories/GHSA-6hqx-gqrx-c5r2) and [all advisories for the servers repository](https://github.com/modelcontextprotocol/servers/security/advisories) (GitHub)
- [MCP specification 2025-11-25: Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) (modelcontextprotocol.io)
- In L2M: [MCP tool policy](/product/mcp-tool-policy), [Approval gates](/product/approvals), [Human approval for agent tool calls](/guides/human-approval-for-agent-tool-calls)
- Related guides: [MCP tool annotations](/learn/mcp/tool-annotations), [Filesystem MCP server](/learn/mcp-servers/filesystem-mcp-server), [The mcpServers JSON config format](/learn/mcp-servers/import-mcp-json-config)
