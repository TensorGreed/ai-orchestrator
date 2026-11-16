---
title: "Playwright MCP server: browser automation for agents"
sidebarTitle: "Playwright MCP server"
description: "Run the open-source Playwright MCP server for an agent: accessibility snapshots vs screenshots, isolated profiles, and limits on where it can browse."
level: intermediate
related: [mcp-server, tool-annotations, write-tool, indirect-prompt-injection, ssrf]
---

# Playwright MCP server: browser automation for agents

The Playwright MCP server (`microsoft/playwright-mcp`, npm package `@playwright/mcp`) gives an agent a real browser: it can open pages, click, type, fill forms and read the result. By default the model works from **accessibility snapshots**, a structured text view of the page in which each element has a reference the next action can target, so no vision model is needed. For an agent, run it headless with an **isolated** profile, give it only the origins it needs, deny the tools that run code or upload files, and ask a person before it submits anything. Its own README says plainly that it "is **not** a security boundary", so the limits have to come from around it as well.

This guide reflects the README on the repository's main branch and the npm release `@playwright/mcp` `0.0.85` (published 2026-11-09), checked on 2026-11-16.

## Snapshots, screenshots and vision

The server's tools act on elements from the latest snapshot:

- `browser_snapshot` returns the page's accessibility tree: roles, names and text, with a reference for each element. `browser_click`, `browser_type`, `browser_select_option` and the others take that reference as their `target`. The README calls this "Deterministic tool application" that "Avoids ambiguity common with screenshot-based approaches". `browser_find` searches the snapshot instead of returning all of it, which saves context on long pages.
- `browser_take_screenshot` returns an image. Its own description says to use `browser_snapshot` for actions by default.
- With `--caps=vision`, coordinate-based mouse tools (`browser_mouse_click_xy` and others) let a vision-capable model click by pixel position, for elements the accessibility tree does not expose.

Snapshots are text, so they cost tokens on large pages. `--snapshot-mode none` stops the server from adding a snapshot to each action's response, and `--image-responses omit` keeps images out of tool results. The README is also candid that coding agents may be better served by its separate CLI; the MCP server suits long-running agent loops that benefit from a live browser state.

## Profiles: persistent, isolated, or your own browser

| Mode | How | What persists |
|---|---|---|
| Persistent (the default) | no flag, or `--user-data-dir <path>` | Cookies and logins, stored under `~/.cache/ms-playwright/mcp-{channel}-{workspace-hash}` on Linux |
| Isolated | `--isolated`, optionally `--storage-state <file>` | Nothing: the profile lives in memory and is lost when the browser closes |
| Extension | `--extension` | Your existing browser tabs and logged-in sessions |

For an agent on a server, use `--isolated`. A persistent profile keeps every session cookie the agent ever got, and only one browser can use it at a time; the README notes that concurrent clients on one workspace conflict. If the agent needs to be logged in, load a dedicated test account's state with `--storage-state` rather than a person's profile. The extension mode, which drives a person's own browser with their sessions, is for interactive use, not for an unattended agent.

## Limits on where it can browse

The flags, as the README's options table lists them:

| Flag | What it does |
|---|---|
| `--allowed-origins <origins>` | Semicolon-separated origins the browser may request. Default: all. |
| `--blocked-origins <origins>` | Semicolon-separated origins to block; checked before the allow-list. |
| `--block-service-workers` | Blocks service workers |
| `--allow-unrestricted-file-access` | Allows file access outside the workspace roots and `file://` URLs. **Off by default**: file access is limited to the workspace roots and `file://` navigation is blocked. |
| `--headless` | Headless browser. The default is headed. |
| `--proxy-server`, `--proxy-bypass` | Send browser traffic through a proxy |
| `--secrets <path>` | A dotenv file of secrets |
| `--redact-url-params <names>` | Replace these query and fragment parameters with `<redacted>` in tool responses |
| `--timeout-navigation`, `--timeout-action` | Navigation timeout (default 60000 ms) and action timeout (default 5000 ms) |

Read the origin flags carefully. For both, the README adds: "Important: *does not* serve as a security boundary and *does not* affect redirects." They keep an honest agent on task. They do not contain a page that redirects elsewhere, or a model that has been talked into going somewhere. For a real limit, route the browser through an allow-listing proxy (`--proxy-server`) or block egress at the network layer.

## Which tools are risky

The server sends <Term id="tool-annotations">MCP tool annotations</Term>. In its source, every tool gets `readOnlyHint` from the tool's own read-only flag, `destructiveHint` as its opposite, and `openWorldHint: true`. So `browser_snapshot`, `browser_take_screenshot`, `browser_find` and `browser_console_messages` are read-only, and everything that changes the page, `browser_navigate` and `browser_click` included, is marked destructive.

A few tools deserve a decision before an agent gets them, all available without extra capabilities:

| Tool | Why it matters |
|---|---|
| `browser_run_code_unsafe` | Runs a Playwright code snippet. Its description says it "executes arbitrary JavaScript in the Playwright server process and is RCE-equivalent". |
| `browser_evaluate` | Runs JavaScript in the page |
| `browser_file_upload`, `browser_drop` | Send local files to the page (within the workspace roots unless file access is unrestricted) |
| `browser_fill_form`, `browser_type`, `browser_click` | Can submit forms, post comments or confirm purchases |
| `browser_network_request` | Returns full request details, headers included |

## Run it

The README's standard config uses `npx @playwright/mcp@latest`. For an agent, pin the version and set the safer flags:

```bash
npx -y @playwright/mcp@0.0.85 --headless --isolated --block-service-workers \
  --allowed-origins "https://status.example.com;https://docs.example.com"
```

It needs Node.js 18 or newer and a browser the server can launch. The Docker image `mcr.microsoft.com/playwright/mcp` ships headless Chromium (the README says the Docker form "only supports headless chromium at the moment") and is tagged by version, for example `v0.0.85`:

```bash
docker run -i --rm --init mcr.microsoft.com/playwright/mcp:v0.0.85 --isolated
```

The image's entrypoint already passes `--headless --browser chromium --no-sandbox`, so extra arguments after the image name are added to those. The README also shows `--port` for an HTTP transport, to run the server as a long-lived service; if you do, keep the default `--host localhost` or put it on a private network, since anyone who can reach the port can drive the browser.

## Attach it to an agent in L2M

Register it as an admin under **MCP → Servers → + Register server** as a stdio server, or import the README's JSON with **Import config** and then pin the version:

```json
{
  "command": "npx",
  "args": ["-y", "@playwright/mcp@0.0.85", "--headless", "--isolated", "--block-service-workers",
           "--allowed-origins", "https://status.example.com"],
  "timeoutMs": 120000
}
```

`@playwright/mcp@0.0.85` counts as pinned for a [deployment catalog](/product/mcp-onboarding#deployment-catalog); `@latest` does not. The built-in **Playwright (Browser)** preset on the registration form fills in the same pinned package with `--headless --isolated`; add `--block-service-workers` and `--allowed-origins` yourself. A server on the API host gets only a [short allowlist](/product/mcp-server-registry#environment-of-stdio-servers-on-the-host) of the API's environment, so if you keep browsers in a custom folder through `PLAYWRIGHT_BROWSERS_PATH`, set it in the server's `env`. Then attach an MCP Tool node for the server to the agent's `tool` port.

Three things to know about how it runs:

- **It runs on the API host by default**, with the API's permissions and network. L2M's [outbound URL checks](/security/outbound-url-checks) do not cover it: they apply to L2M's own nodes, and this browser is launched by the MCP server process, which makes its own connections.
- **L2M can contain it** in a container sandbox ([sandboxed stdio servers](/product/mcp-server-registry#sandboxed-stdio-servers)): read-only root filesystem, non-root user, no capabilities, CPU and memory limits, and no network unless an admin turns it on. A browser agent needs the network, and L2M's sandbox networking does not filter hosts, so keep a proxy or egress rule for that. The sandbox defaults (512 MB of memory, a 64 MB `/tmp`) were not chosen with a browser in mind; raise them and set the working directory to `/tmp`. L2M does not send workspace roots, so the server treats its working directory as the workspace root and saves named files such as screenshots there, and the image's own working directory (`/home/node`) is not writable under the sandbox's read-only root filesystem. With the official image, whose entrypoint already starts the server, the command is the first server flag (for example `--isolated`) and the arguments are the other flags; an `npx` command would reach the server as a stray argument. Test the setup with **Probe now** before you rely on it.
- **[Network controls](/security/network-controls)** limit which client addresses can reach L2M itself. They do not limit where an MCP server connects.

## Least privilege in L2M

Because `browser_navigate` and `browser_click` are write tools by their annotations, the workflow-wide **No write tools** switch would leave the agent with a browser that cannot open a page. Use [tool policy rules](/product/mcp-tool-policy) instead. All of these are optional:

1. **Deny the code tools.** A deny rule on this server for `browser_run_code_unsafe`, another for `browser_evaluate`, and one for `browser_file_upload` and `browser_drop` if the agent never uploads.
2. **Limit where it navigates.** Deny `browser_navigate`, then allow it where `url` `starts_with` `https://status.example.com/` ([conditions](/product/mcp-tool-policy#conditions)). This checks the URL the model asks for. Redirects and links clicked on the page are not covered, which is why the proxy matters.
3. **Ask before it submits.** A `require_approval` rule on `browser_fill_form` and `browser_type` pauses the run until a person approves the call with its arguments ([require approval](/product/mcp-tool-policy#require-approval)). For a broader gate, **Ask before write tools** asks before every tool an admin has not marked read-only ([approval before write tools](/product/approvals#approval-before-write-tools)); mark the navigation and snapshot tools read-only if the agent only reads, or every step will ask.
4. **Watch for planted instructions.** Pages are untrusted text, and instructions hidden in them are <Term id="indirect-prompt-injection">indirect prompt injection</Term>. **Approve writes only after untrusted content** asks for approval before a write tool once a tool result is in the agent's context ([untrusted content and write tools](/guides/govern-mcp-tools#untrusted-content-and-write-tools)). For a browser agent, where nearly every action is a write tool, that means approval for most steps after the first page, so it suits low-volume agents best.

## Playwright MCP or L2M's Web Browse node

L2M has a built-in [Web Browse node](/nodes/web-browse) that also drives headless Chromium through Playwright. They solve different problems:

| | Web Browse node | Playwright MCP server |
|---|---|---|
| Who decides what to do | The workflow: one URL per run | The agent, step by step |
| Interaction | Loads one page, waits, extracts | Clicks, types, fills forms, uses tabs |
| Output | Title, text, HTML, links, images, meta tags, optional screenshot | Accessibility snapshots, screenshots, console and network logs |
| JavaScript from the caller | Not exposed | `browser_evaluate`, `browser_run_code_unsafe` |
| Network checks | Every request and WebSocket the page opens goes through L2M's outbound URL checks (not DNS-pinned; service worker requests and WebRTC are not checked) | The server's origin flags, which are not a security boundary |
| State | A fresh browser per run | Isolated or persistent profile |
| As an agent tool | Wrap a Web Browse workflow in a [Workflow Tool](/runtime/workflow-tool) | Attach the MCP server |

Use Web Browse when the job is "read this page": it is simpler, it runs under the URL checks, and it cannot be talked into clicking anything. Use the Playwright MCP server when the agent genuinely has to interact with a site, and put the limits above around it.

## Test it without a browser

A browser agent's test that hits live pages breaks whenever a page changes. Record one good run with **Record MCP calls** on, then point a copy of the workflow at a **Snapshot mock server** built from this server's snapshot and the cassette ([snapshot mock servers](/product/testing-mcp-workflows#snapshot-mock-servers)). The mock answers each call with the recorded result (the page snapshots the agent saw) and checks arguments against each tool's schema, with no browser and no network. When you move to a new `@playwright/mcp` version, `pnpm l2m mcp check --server <id>` reports tools that were removed or changed incompatibly; the README's tool list changes between releases. See [Test MCP servers in CI](/guides/test-mcp-servers-in-ci).

## Try it in L2M

The [brand extraction recipe](/recipes/brand-extraction-web) shows the Web Browse side: a page rendered in headless Chromium under the outbound URL checks, then read by a model. It needs an OpenAI API key and Chromium on the API host (`pnpm exec playwright install chromium`).

## Further reading

- [microsoft/playwright-mcp README](https://github.com/microsoft/playwright-mcp) (Microsoft)
- [@playwright/mcp on npm](https://www.npmjs.com/package/@playwright/mcp) (npm)
- [MCP Security Best Practices](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices) (Model Context Protocol), which the Playwright README points to
- In L2M: [Web Browse node](/nodes/web-browse), [Outbound URL checks](/security/outbound-url-checks), [Network controls](/security/network-controls), [MCP tool policy](/product/mcp-tool-policy), [MCP server registry](/product/mcp-server-registry)
- Concepts: [MCP tool annotations](/learn/mcp/tool-annotations), [Prompt injection](/learn/security/prompt-injection)
