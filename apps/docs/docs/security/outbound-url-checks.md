---
title: "Outbound URL checks: block request forgery in nodes"
description: "L2M outbound URL checks cover every URL that HTTP Request, Web Browse, Chart, PDF, RAG and feed nodes fetch, blocking request forgery and local file reads."
---

# Outbound URL checks

Nodes that fetch a URL the workflow author or upstream data supplies —
**HTTP Request**, [**Web Browse**](/nodes/web-browse), the [**Chart**](/nodes/chart) node's `data.url`, the
**PDF** node in HTML-render mode (including every sub-resource and WebSocket
the page opens), and **RAG** endpoints set on a node (a vector store's
`endpoint`, an embedder's `baseUrl`, the Azure OpenAI embeddings node's
`endpoint`), plus the **RSS** trigger's feed URL and the **SSE** trigger's
stream URL — run that URL through a shared check before any request leaves
the host. This
blocks server-side request forgery (SSRF) and local-file reads through those
nodes.

Document scans use the same checks: the rule set page's
[Scan a document](/product/content-rules#scanning-documents) under this
policy, and the MCP gateway's
[scan_document](/product/content-rules-tools#scan-document) tool, which also
always refuses private, loopback and link-local addresses and fetches only
from the hosts its toolset lists (on the scheme's default port unless the
entry names one). Their fetch timeout covers DNS lookups, and a caller that
goes away stops the fetch.

Requests to the deployment's
[names and addresses service](/product/content-rules-engine#names-locations-and-street-addresses)
(`CONTENT_RULES_NER_ENDPOINT`) go through the same checks with one deliberate
exception: the configured host and port are allowed even under
`OUTBOUND_DENY_PRIVATE`, because an admin named them and the service usually
runs on the internal network. Metadata and link-local addresses stay refused,
and redirects are never followed.

A model's **base URL** set on a model node, in a provider test, on a `/v1`
route, on an embedding call or a knowledge base embedder, or in the editor's
**Load models** request goes through the same policy before the call, and a
name that does not resolve is refused. The call is then pinned to the
addresses that were checked, like HTTP Request: a name that answers
differently on a second lookup cannot move the connection. The URL keeps its
host name, so TLS (SNI and the certificate check) and the `Host` header are
the name's. Model calls never follow redirects. Base URLs that come from the
server's environment (`OLLAMA_BASE_URL`, `AZURE_OPENAI_ENDPOINT`,
`EVAL_JUDGE_BASE_URL`, `PROVIDER_ENV_KEY_BASE_URLS`) and each provider's own
default endpoint are neither checked nor pinned. That covers only URLs under
the configured URL's path: another path on the same host, or a base URL with a
query or fragment, is checked like any other. Ollama's built-in localhost
default (used when neither the node nor `OLLAMA_BASE_URL` names one) is
checked too, so with `OUTBOUND_DENY_PRIVATE` on, set `OLLAMA_BASE_URL`.

A server model key (`OPENAI_API_KEY` and the rest) is only ever sent to that
provider's own endpoint, to `AZURE_OPENAI_ENDPOINT` for Azure OpenAI, to a
base URL under one listed in `PROVIDER_ENV_KEY_BASE_URLS` (same origin, and a
path under the listed path, without percent-encoded `/`, `\` or `.` below
it), or to `EVAL_JUDGE_BASE_URL` when
`EVAL_JUDGE_ALLOW_ENV_CREDENTIALS` is on; a node with any other base URL must
use a secret. A `PROVIDER_ENV_KEY_BASE_URLS` entry written
`openai=https://gw.example/v1` is for that provider's key only. A bare URL
gets the key of whichever provider a node picks with it, which is less
strict: prefer per-provider entries. The two forms cannot be mixed in one
value. `EVAL_JUDGE_BASE_URL` carries only the judge provider's key
(`EVAL_JUDGE_PROVIDER_ID`).

Concepts: [the lethal trifecta](/learn/security/lethal-trifecta) shows how URLs become a way for data to leave an agent.

MCP HTTP servers do not go through these checks. For the OAuth discovery,
registration, token and refresh requests of remote MCP servers, set
`MCP_OAUTH_BLOCK_PRIVATE_HOSTS=true` (off by default) to refuse private,
loopback, link-local and cloud metadata addresses; see
[OAuth for remote servers](/product/mcp-server-registry#oauth-for-remote-servers).
Limit where the API host can connect to MCP servers with egress rules at the
network layer (a firewall or an outbound proxy).

## Policy

- **Schemes.** Only `http:` and `https:` can be fetched. `file:`, `data:`,
  `javascript:` and anything else are refused, so one of these nodes can never
  read the local disk or run inline script through a URL. Two exceptions are
  inline content, not fetches: Chart image marks and the Web Browse page itself
  may be `data:` URLs (see below).
- **Always blocked.** Cloud metadata endpoints (`169.254.169.254`,
  `fd00:ec2::254`, `metadata.google.internal` and the like) and link-local,
  multicast, unspecified, reserved and documentation ranges. The allowlist
  never overrides these.
- **Private ranges and localhost** are allowed by default. Turn on
  `OUTBOUND_DENY_PRIVATE` to block them, then use `OUTBOUND_ALLOWLIST` to let
  specific internal hosts or networks back through.

The host is resolved and **every** address it resolves to is classified, so a
name that points at a blocked address is refused. Redirects are re-checked hop
by hop. A redirect to another origin drops the credential headers
`Authorization`, `Proxy-Authorization`, `Cookie`, `api-key` and `x-api-key`,
and the browser-based nodes check each sub-resource the page requests,
not just the first document. WebSockets a page opens (`ws:` / `wss:`) get the
same host check; a refused socket is closed before it connects. A refused URL
fails the node at once and is not retried.

**Inline chart images.** A Chart spec may use `data:image/...` URLs for image
marks; they are decoded locally and never fetched. Each one is capped at 2 MB
(encoded). Other `data:` URLs and `file:` loads are refused.

**Inline pages in Web Browse.** The Web Browse node also accepts a `data:` URL
as the page to open, for example `data:text/html,...` built by an upstream
node. The page is rendered from the URL itself, so nothing is fetched for it;
everything the page then loads (`http:`/`https:` sub-resources, navigations
and WebSockets) goes through the checks above. `file:` stays refused.

**Credentials and node-supplied RAG endpoints.** When a RAG node names its own
`endpoint` or `baseUrl`, only the node's own secret (`embeddingSecretRef`) is
sent there. The deployment's environment keys (`OPENAI_API_KEY`,
`QDRANT_API_KEY` and the like) only ever go to the deployment's own endpoints,
so a workflow author cannot point a node at their own server to collect them.

**DNS rebinding.** For HTTP Request, the Chart node, node-configured RAG
endpoints and the RSS and SSE triggers, the connection is pinned. The socket's own DNS lookup goes through the check: the name is
resolved once at connect time, every address is checked, and the socket can
only connect to an address that passed. A name that answers a public address
to the first check and a metadata or private address a moment later is
refused. The URL keeps its hostname, so TLS SNI, certificate validation and
the `Host` header are unchanged.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `OUTBOUND_DENY_PRIVATE` | `false` | Also block private ranges and localhost for the checked nodes. |
| `OUTBOUND_ALLOWLIST` | empty | Comma-separated hosts or CIDRs allowed through under `OUTBOUND_DENY_PRIVATE`, e.g. `10.0.0.0/8,*.internal,db.corp:5432`. |
| `PROVIDER_ENV_KEY_BASE_URLS` | empty | Comma-separated base URLs a server model key may also be sent to, besides each provider's own endpoint (for example your own model gateway). `openai=https://gw.example/v1` is for that provider's key only (providers: `openai`, `anthropic`, `azure_openai`, `gemini`); a bare URL is for any provider's key. |

## What is not covered

- **HTTP proxies.** The pinned fetches connect directly and ignore
  `HTTP_PROXY`, `HTTPS_PROXY` and `NODE_USE_ENV_PROXY`. On a host whose only
  way out is through a proxy, HTTP Request, Chart `data.url`, node RAG
  endpoints and the RSS/SSE triggers cannot reach the internet. Proxy support
  is not implemented: with a proxy, the proxy resolves the name, so the
  connection could not be pinned to the vetted address.
- **Browser-based nodes are not pinned.** Web Browse and the HTML-render PDF
  path check each request and WebSocket at route time, but Chromium then
  resolves the name itself. A short-TTL rebinding name can still pass the check and connect
  elsewhere. Under `OUTBOUND_DENY_PRIVATE` that is a gap for private ranges;
  the metadata block is affected the same way.
- **Python code nodes on the host** open their own sockets and never go
  through these checks. See
  [Code execution](./code-execution.md#python-on-the-host).
- **Other browser channels.** WebRTC, and requests a service worker makes,
  are not routed through the checks.
- **Model providers from community packages** are checked like the built-in
  ones, but their connection is pinned only if the adapter sends its requests
  through the call context's `fetch`; one that uses its own HTTP client is
  checked, not pinned.
- **Ollama with no base URL** goes to `OLLAMA_BASE_URL`, or to
  `http://localhost:11434` when that is unset, without a check (also under
  `OUTBOUND_DENY_PRIVATE`): the default is the deployment's, not a node's.
- **Deployment-level endpoints** are infrastructure settings and are not
  checked: LLM provider base URLs from the environment, connector SDK endpoints, and RAG endpoints
  that come from environment variables (`QDRANT_ENDPOINT`, `CHROMA_ENDPOINT`
  and the like) rather than from a node. MCP HTTP servers and MCP OAuth
  discovery are not checked either (see above).
