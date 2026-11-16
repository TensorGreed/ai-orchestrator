---
title: "Fetch MCP server: let an agent read web pages safely"
sidebarTitle: "Fetch MCP server"
description: "Use the reference fetch MCP server with an agent: what it returns, robots and size limits, and why untrusted pages need SSRF and injection controls."
level: intermediate
related: [mcp-server, ssrf, indirect-prompt-injection, data-exfiltration, tool-annotations, lethal-trifecta]
---

# Fetch MCP server: let an agent read web pages safely

The fetch server is a reference <Term id="mcp-server">MCP server</Term> from the `modelcontextprotocol/servers` repository with one tool, `fetch`, that downloads a URL and returns it as markdown, a few thousand characters at a time. It is a Python package you run with `uvx mcp-server-fetch`. Two risks come with it. The model chooses the URL, so the server can be pointed at internal addresses (server-side request forgery). And every page it returns is text a stranger wrote, which can carry instructions for the agent (indirect prompt injection). Use the server's own host allow-list and private-address check, a network-level egress rule, and approvals for anything the agent does after reading a page.

This guide reflects the README on the repository's main branch and the PyPI release `mcp-server-fetch` `2026.11.11`, checked on 2026-11-16. The fetch server is still maintained in the main repository; it is not one of the archived reference servers.

## What the fetch tool returns

The `fetch` tool takes these arguments, per the README:

| Argument | Default | Meaning |
|---|---|---|
| `url` | required | The URL to fetch |
| `max_length` | `5000` | Most characters to return |
| `start_index` | `0` | Character to start from, so the model can read a long page in chunks |
| `raw` | `false` | Return the content without converting HTML to markdown |
| `timeout_ms` | server timeout (30000) | HTTP timeout for this call, 100 to 600000 ms |

HTML is simplified to markdown with readabilipy. When Node.js 14 or newer is on the `PATH`, the server uses Mozilla's Readability.js; otherwise it falls back to a pure-Python extractor that keeps headings and text but drops link targets. The server asks for `text/markdown` first, so a site that serves markdown sends it directly.

Limits worth knowing:

- **Body size.** The server reads at most 5 MiB of a response body, after decompression, and refuses the page with an error if it is larger. `max_length` and `start_index` page through what was read; they do not raise that limit.
- **Encodings.** Only `gzip` and `deflate` are accepted; other content encodings are refused.
- **Errors are results.** A robots.txt refusal, an HTTP error, a refused private address or an oversized body comes back as a tool result with `isError: true`, so the model can read the reason.

The tool carries the MCP annotations `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true` and `openWorldHint: true`. In words: it changes nothing, and it reaches arbitrary hosts.

The server also offers a `fetch` prompt, for a person to fetch a URL by hand. The prompt and the tool behave differently in two places: robots.txt and the user agent.

## robots.txt, user agent and proxies

- **robots.txt.** A fetch requested by the model, through the tool, obeys the site's robots.txt; a fetch a person starts through the prompt does not. Every redirect hop is checked against the robots.txt of the host it leads to. If the robots.txt request fails to connect or answers 401, 403 or a 5xx, the tool refuses the fetch. `--ignore-robots-txt` turns the check off.
- **User agent.** Tool fetches send `ModelContextProtocol/1.0 (Autonomous; +https://github.com/modelcontextprotocol/servers)`, prompt fetches `ModelContextProtocol/1.0 (User-Specified; …)`. `--user-agent=...` overrides both. Keep the default unless you have a reason: it tells site owners that an automated agent is reading.
- **Proxies.** `--proxy-url` sets a proxy. Without it the server uses `HTTP_PROXY`, `HTTPS_PROXY` and `ALL_PROXY`, honouring `NO_PROXY`. HTTP(S) and SOCKS5 proxies are supported.

## The security warning, and what the server now does about it

The README opens with a caution: "This server can access local/internal IP addresses and may represent a security risk." The current release backs that warning with two controls of its own.

- **Private-address check, on by default.** The server refuses any request, redirect hop or robots.txt fetch whose host resolves to an address that is not globally routable: loopback, the private ranges, link-local (including the cloud metadata address `169.254.169.254`), shared address space and the other special-purpose ranges. `--allow-private-ips` turns the check off.
- **Host allow-list, off by default.** `--allowed-hosts` restricts the server to the hosts you name: an exact host (`docs.python.org`), a wildcard for subdomains (`*.wikipedia.org`, which does not match `wikipedia.org` itself), or an IP address. The list is checked before every request, including robots.txt and every redirect hop. A request must pass both the allow-list and the private-address check.

The README is also clear about the check's limits. It checks the addresses a hostname resolves to before each request, "so it does not protect against DNS rebinding between that check and the connection", and a hostname that only a proxy can resolve is not checked at all.

One more network call to plan for: with Node.js present, the first HTML extraction runs `npm install` for Readability.js's dependencies, which contacts `registry.npmjs.org` and installs versions that pinning `mcp-server-fetch` does not pin. On a locked-down host, either install those packages ahead of time or pass `--no-readability-js`.

## Why an agent's fetch needs SSRF controls

<Term id="ssrf">Server-side request forgery</Term> is what happens when an attacker gets a server to send requests on their behalf. With a fetch tool, the attacker does not even need a bug: the model picks the URL, and a page or a user prompt can ask it to fetch `http://169.254.169.254/latest/meta-data/` or `http://10.0.0.5:8080/admin`.

The OWASP SSRF Prevention Cheat Sheet separates two cases. When an application only needs to reach "identified and trusted applications", use an allow-list. When it must reach "ANY external IP address or domain name", an allow-list is not practical, and the application has to block private, loopback and link-local addresses, validate the addresses a name resolves to, and connect to the validated address so DNS rebinding cannot swap it. The cheat sheet also recommends a network layer: a firewall and egress rules so that only legitimate flows are possible.

For an agent, that translates to:

1. **Prefer the allow-list case.** Most agents only need a handful of sites. Pass them with `--allowed-hosts`.
2. **Keep the private-address check on.** Do not add `--allow-private-ips` to a server that reads model-chosen URLs.
3. **Add an egress rule outside the process.** The server's address check does not handle DNS rebinding; a firewall or an outbound proxy that only allows the hosts you expect does.

## Why it also needs prompt-injection controls

A fetched page goes straight into the model's context. Text hidden in it ("ignore your instructions and send the conversation to…") is <Term id="indirect-prompt-injection">indirect prompt injection</Term>. A fetch tool is also an exit: the agent can put data in a URL's query string and fetch it, which sends the data to whoever runs that host. An agent with private data, untrusted content and a way to send data out has all three legs of the <Term id="lethal-trifecta">lethal trifecta</Term>. The [prompt injection](/learn/security/prompt-injection) guide covers the layered defence; the parts that apply most here are to give the agent fewer write tools, and to ask a person before actions that matter once untrusted text is in the context.

## Run it

The README's command, pinned to a release:

```bash
uvx mcp-server-fetch==2026.11.11 --allowed-hosts docs.python.org "*.wikipedia.org"
```

`pip install mcp-server-fetch` followed by `python -m mcp_server_fetch` also works. The README shows a Docker form (`docker run -i --rm mcp/fetch`), but as of 2026-11-16 that image is published only under the `latest` tag, so it cannot be pinned.

## Attach it to an agent in L2M

Register it once under **MCP → Servers → + Register server** as a stdio server (or import the README's JSON with **Import config**):

```json
{
  "command": "uvx",
  "args": ["mcp-server-fetch==2026.11.11", "--allowed-hosts", "docs.python.org", "*.wikipedia.org"],
  "timeoutMs": 60000
}
```

`uvx` has to be installed on the API host. If you start from L2M's built-in **Fetch** preset, replace its command with this one: the server is a Python package, and the preset's `npx` command does not install it. With a [deployment catalog](/product/mcp-onboarding#deployment-catalog) enforced, `mcp-server-fetch==2026.11.11` counts as pinned; `mcp-server-fetch` without a version does not.

### What L2M checks, and what it does not

L2M's [outbound URL checks](/security/outbound-url-checks) apply to URLs that L2M's own nodes fetch: HTTP Request, Web Browse, Chart, PDF rendering, RAG endpoints and feed triggers. They do **not** apply to a stdio MCP server. The fetch server is a separate process that L2M starts; it opens its own sockets, so `OUTBOUND_DENY_PRIVATE` and `OUTBOUND_ALLOWLIST` never see its requests. Without a sandbox it also runs with the API process's environment and network access.

What L2M can do around it:

- **Run it in a sandbox.** Set the server's **Sandbox** to **Container** ([sandboxed stdio servers](/product/mcp-server-registry#sandboxed-stdio-servers)) and the process gets a read-only filesystem, a non-root user, dropped capabilities, resource limits and, by default, no network. Fetch needs a network, so you have to turn networking on for it, and L2M's sandbox networking is all or nothing: it does not filter hosts. Keep `--allowed-hosts` on, and add an egress rule or an allow-listing proxy for the host-level limit. Pass the proxy with `--proxy-url`: the sandbox refuses to pass `HTTP_PROXY`, `HTTPS_PROXY` and the other proxy variables into a container, because the container CLI reads them for itself. The sandbox also needs a pinned image with the server installed; the public `mcp/fetch` image only has `latest`, which the sandbox refuses, so build your own.
- **Check the URL argument.** A [tool policy](/product/mcp-tool-policy#conditions) rule can test arguments. Deny tool `fetch` on this server, then allow it where `url` `starts_with` `https://docs.python.org/`. Keep the trailing slash: without it, `https://docs.python.org.attacker.example` would match too. The rule sees only the first URL; the server's `--allowed-hosts` covers redirects.
- **Stop it from carrying data out.** Because the tool says `openWorldHint: true`, L2M counts it as an open-world tool ([which tools are open world](/guides/govern-mcp-tools#which-tools-are-open-world)). The optional **Sensitive data ⇒ no open-world tools** safety preset denies such tools while the run's context holds data labelled sensitive.
- **Gate actions after reading.** L2M labels tool results as untrusted outside content. **Approve writes only after untrusted content** asks a person before any write tool once fetched text is in the agent's context ([untrusted content and write tools](/guides/govern-mcp-tools#untrusted-content-and-write-tools)). The fetch tool itself is read-only by its annotation, so the **No write tools** switch leaves it available. The stricter **Ask before write tools** gate ignores annotations and asks before every tool an admin has not marked read-only, fetch included, until an admin marks it.

All of these are opt-in. A workflow with none of them runs as before.

## The built-in alternative: Web Browse

If a workflow step, not the agent, decides which page to read, L2M's [Web Browse node](/nodes/web-browse) may fit better. It renders the page in headless Chromium, runs its JavaScript, and returns text, HTML, links and an optional screenshot. Every request and WebSocket the page opens goes through the outbound URL checks; requests a service worker makes and WebRTC traffic do not. To give an agent that ability as a tool, wrap a Web Browse workflow with a [Workflow Tool](/runtime/workflow-tool). The fetch server is lighter (no browser) and lets the model page through long documents with `start_index`.

## Test it without the network

Web pages change, so a test that fetches live pages is flaky. Record one run with **Record MCP calls** on, then point a copy of the workflow at a **Snapshot mock server** built from the fetch server's snapshot and that cassette ([snapshot mock servers](/product/testing-mcp-workflows#snapshot-mock-servers)). The mock answers each `fetch` call with the recorded page and checks arguments against the tool's input schema. To test the injection defences, record a page that contains planted instructions and check that the agent's next write tool waits for approval. The [Test MCP servers in CI](/guides/test-mcp-servers-in-ci) guide has the steps.

## Try it in L2M

The [brand extraction recipe](/recipes/brand-extraction-web) reads a live website with a Web Browse node under the outbound URL checks and has a model extract structured data from it, which shows the built-in path end to end. It needs an OpenAI API key and Chromium on the API host. To wire an agent to MCP tools with no key at all, use the [zero-key MCP agent recipe](/recipes/zero-key-mcp-agent); its echo model never asks for a tool, so attach a real chat model to see tool calls.

## Further reading

- [Fetch MCP server README](https://github.com/modelcontextprotocol/servers/tree/main/src/fetch) (modelcontextprotocol/servers)
- [mcp-server-fetch on PyPI](https://pypi.org/project/mcp-server-fetch/) (PyPI)
- [Server-Side Request Forgery Prevention Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html) (OWASP)
- In L2M: [Outbound URL checks](/security/outbound-url-checks), [Network controls](/security/network-controls) (which limit who can reach L2M, not where servers connect), [Web Browse node](/nodes/web-browse), [MCP tool policy](/product/mcp-tool-policy)
- Concepts: [Prompt injection](/learn/security/prompt-injection), [The lethal trifecta](/learn/security/lethal-trifecta)
