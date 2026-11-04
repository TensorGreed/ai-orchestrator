---
description: "Limit L2M by client address per scope (UI, API, webhooks, MCP gateway, metrics), roll out in report mode, keep break-glass, and pin MCP client certificates."
---

# Network controls

Network controls limit which client addresses may reach each part of L2M, and let an MCP gateway client require a
client certificate on top of its token. Everything here is optional: with no setting, every address reaches every
route, as before.

There are two kinds of list:

- **Deployment lists, per scope**, set in the environment (`NETWORK_ALLOW_*`). They are the same on every replica and
  cannot be changed from the studio, so a wrong save can never lock you out. **Settings › Access control › Network**
  shows them read-only, with your address and the lists it matches.
- **Object lists**, on one MCP gateway client or one webhook trigger, set in the studio or the API.

Each list is a comma list of IP addresses and CIDR ranges, IPv4 or IPv6 (`10.0.0.0/8, 192.168.1.5, 2001:db8::/32`).
An IPv4-mapped IPv6 address (`::ffff:10.0.0.1`, what a dual-stack listener reports) matches the IPv4 ranges.

## Scopes

Each request falls in one scope by its path and credential. A scope without a list is open.

| Scope | Setting | Requests |
|---|---|---|
| UI | `NETWORK_ALLOW_UI` | `/api/*` with a session cookie or no credential: the studio's calls, sign-in, SSO and OIDC callbacks, the MCP OAuth callback |
| API | `NETWORK_ALLOW_API` | `/api/*` with an `Authorization` header (an API key or bearer token), including `/api/webhooks/execute` and `/api/triggers/manual/*` |
| Webhook | `NETWORK_ALLOW_WEBHOOK` | `/webhook/*`, `/webhook-test/*`, provider webhooks (`/api/webhooks/slack/*` and the others), `/api/mcp-server/*` |
| Public | `NETWORK_ALLOW_PUBLIC` | Forms (`/api/forms/*`), chat (`/api/chat/*`), `/widget.js`, `/helper-chat` |
| MCP gateway | `NETWORK_ALLOW_MCP_GATEWAY` | `/mcp/*` |
| Metrics | `NETWORK_ALLOW_METRICS` | `/metrics`, `/api/docs`, `/api/openapi.json` |

`/health`, `/ready` and the SAML metadata (`/api/auth/saml/metadata`, which the identity provider fetches) are never
checked, so health checks and probes keep working. A request with both a session cookie and an `Authorization`
header must pass both the UI and the API list, since the server accepts either credential.

The studio's own HTML and JavaScript are served by the `web` container (nginx), not the API, so the UI list covers
the studio's API calls. To hide the page itself, add `allow` / `deny` rules in nginx or an ingress annotation such as
`nginx.ingress.kubernetes.io/whitelist-source-range`.

## The client address

Every check uses the address the API counts the request from: the connecting address, or with `TRUST_PROXY` the
address your proxy reports in `X-Forwarded-For` (see [Environment](../getting-started/environment.md)). The same
address appears in the audit log.

- Behind a proxy, set `TRUST_PROXY` first. Without it every request is checked as the proxy's address. The Network
  tab warns when your request arrived through a proxy while `TRUST_PROXY` is off.
- `TRUST_PROXY=true` trusts every hop, so any client could choose the address it is checked by. The API refuses to
  start with a `NETWORK_ALLOW_*` list and `TRUST_PROXY=true`, and refuses per-client lists while it is set. Behind the
  shipped nginx use `TRUST_PROXY=1` or the proxy's address.
- Keep port 4000 reachable only through the proxy.

A list entry that is not an address or range refuses to start, naming the setting and the entry:

```text
Invalid environment configuration: NETWORK_ALLOW_API entry "10.0.0.300/8" is not an IP address or CIDR range
```

## What a refused request sees

A refused request gets `403` with a fixed body, `{"error":"Access from this address is not allowed"}`, or on
`/mcp/*` a JSON-RPC error with code `-32001` and the same message. The body never names the list or the address. The
check runs before rate limiting, so refused requests use no rate-limit budget.

Refusals are recorded:

| Record | When |
|---|---|
| Audit `network.request_denied` | A list refused a request. At most once a minute per address and scope (per client or trigger for object lists), with the scope, the list, the method and the path (never the query). |
| Audit `network.request_would_be_denied` | The same, in report mode. |
| Audit `network.break_glass_used` | A break-glass address was admitted outside the list (at most once a minute per address and scope). |
| Metric `ao_network_requests_total{scope,outcome}` | Every refused (`denied`), would-be refused (`would_deny`) and break-glass (`break_glass`) request. The series appears once something was counted. |

Streams and MCP sessions are checked when they connect and on every new request; a list change does not close a
stream that is already open.

## Rolling out with report mode

1. Set `NETWORK_ALLOWLIST_MODE=report` and the lists you want. Nothing is refused.
2. Watch the audit log for `network.request_would_be_denied` (filter by event type) and the
   `ao_network_requests_total{outcome="would_deny"}` metric for a few days. Each entry names the address and scope.
3. Add the missing ranges, then remove `NETWORK_ALLOWLIST_MODE` (the default is `enforce`) and restart.

Report mode applies to every address list, deployment and object lists alike. It does not apply to client
certificates, which are part of the credential.

## Break-glass

`NETWORK_BREAK_GLASS_CIDRS` lists addresses that are always admitted on the UI and API scopes. It defaults to
loopback (`127.0.0.0/8, ::1`), so an admin on the host (or through an SSH tunnel to it) can still sign in when a list is
wrong. Every admission through it is audited as `network.break_glass_used` and raises the `network.break_glass_used`
notification (at most once every 10 minutes per address); pick **Break-glass access used** on a notification channel,
and channels set from the environment get it automatically. Set `NETWORK_BREAK_GLASS_CIDRS=none` to turn it off.

Break-glass never opens the webhook, public, gateway or metrics scopes. Since the lists live in the environment,
fixing a wrong one is a change to the environment and a restart, never a database edit.

::: warning Behind a proxy on the same host
If the proxy reaches the API over loopback and `TRUST_PROXY` is off, every request arrives from `127.0.0.1` and
break-glass admits all of them. Set `TRUST_PROXY` so the client's own address is checked.
:::

## Per-client lists and certificates (MCP gateway)

Open **MCP › Clients**, pick a client and **Network**. An admin can set:

- **Allowed addresses**: the client's token works only from these addresses. Empty means any address.
- **Client certificate fingerprints**: SHA-256 fingerprints of the certificates the client may present. With at
  least one listed, every call needs the token **and** one of these certificates. Get a fingerprint with
  `openssl x509 -in client.pem -noout -fingerprint -sha256` (colons are fine).
- **Certificate subject pin** (optional): the certificate must also carry this name, as its subject CN or one of its
  subject alternative names (for example `spiffe://example.org/agent`). A pin survives re-issuing the certificate under
  the same name, while the fingerprint changes.

Rotate a certificate by listing the new fingerprint next to the old one, moving the client to the new certificate,
then removing the old fingerprint. Each change is audited as `mcp_client.network_updated` with the values before and
after. The same settings are on the API: `PUT /api/mcp/clients/:id/network` with `allowedIps`, `certFingerprints`
and `certSubject` (each field given replaces the stored one).

A call that fails the certificate check gets `401` and is audited as `mcp_gateway.client_certificate_refused` (at most
once a minute per client, address and reason: `none`, `untrusted`, `invalid`, `expired` or `mismatch`). A call from an
address outside the client's list gets the `403` above.

### How the certificate reaches L2M

The API does not terminate TLS. The proxy in front of it verifies the client certificate against your client CA and
forwards it in a header. Two settings turn this on:

| Setting | Meaning |
|---|---|
| `MCP_GATEWAY_CLIENT_CERT_HEADER` | The header the proxy forwards the certificate in. Unset = off (a client with fingerprints then cannot connect, so they cannot be saved). |
| `MCP_GATEWAY_CLIENT_CERT_PROXIES` | Addresses of the proxies allowed to set that header. Defaults to `TRUST_PROXY` when that is an address list; otherwise required. |

The header is honoured only when the connection itself comes from one of those proxies (the socket address, not the
forwarded one); from anywhere else it is ignored, so a client cannot present a certificate by sending the header
itself. Your proxy must also **overwrite** the header on every request rather than pass a client's value through. The
API reads a PEM certificate, URL-encoded PEM (nginx `$ssl_client_escaped_cert`, ingress-nginx, AWS ALB), an Envoy
`x-forwarded-client-cert` element with `Cert="…"`, or base64 DER, and checks its validity dates again.

**nginx.** Verify client certificates where nginx terminates TLS and forward them on `/mcp/`:

```nginx
server {
  listen 443 ssl;
  server_name l2m.example.com;
  ssl_certificate         /etc/nginx/tls/server.crt;
  ssl_certificate_key     /etc/nginx/tls/server.key;
  ssl_client_certificate  /etc/nginx/tls/client-ca.pem;
  # optional: the studio and clients without a pinned certificate connect without one;
  # a certificate that is presented must verify against client-ca.pem.
  ssl_verify_client       optional;
  ssl_verify_depth        2;

  location /mcp/ {
    proxy_pass         http://api:4000;
    proxy_http_version 1.1;
    proxy_buffering    off;
    proxy_read_timeout 3600s;
    proxy_set_header   Host              $host;
    proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
    # Always set (empty when no certificate was presented), so a client's own header never passes through.
    proxy_set_header   X-SSL-Client-Cert $ssl_client_escaped_cert;
  }
}
```

```bash
TRUST_PROXY=1
MCP_GATEWAY_CLIENT_CERT_HEADER=x-ssl-client-cert
MCP_GATEWAY_CLIENT_CERT_PROXIES=172.18.0.0/16   # the nginx container's network
```

**Kubernetes ingress-nginx.** Ask the controller to verify client certificates and pass them on; it sends the
certificate URL-encoded in the `ssl-client-cert` header:

```yaml
metadata:
  annotations:
    nginx.ingress.kubernetes.io/auth-tls-secret: "l2m/client-ca"        # a Secret with ca.crt
    nginx.ingress.kubernetes.io/auth-tls-verify-client: "optional"
    nginx.ingress.kubernetes.io/auth-tls-verify-depth: "2"
    nginx.ingress.kubernetes.io/auth-tls-pass-certificate-to-upstream: "true"
```

```yaml
config:
  TRUST_PROXY: "10.0.0.0/8"                      # the controller's pod range
  MCP_GATEWAY_CLIENT_CERT_HEADER: "ssl-client-cert"
  MCP_GATEWAY_CLIENT_CERT_PROXIES: "10.0.0.0/8"
```

**Envoy.** Set `forward_client_cert_details: SANITIZE_SET` with `set_current_client_cert_details: { cert: true }` and
`MCP_GATEWAY_CLIENT_CERT_HEADER=x-forwarded-client-cert`.

A native TLS listener for the gateway (for deployments without a TLS-terminating proxy) is not part of this release.

## Per-webhook lists

A **Webhook** trigger has an optional **Allowed Addresses** field (one IP or CIDR range per line; `allowedIps` in the
node's config). When set, only those addresses can call the trigger; others get the `403` above before the trigger's
own authentication runs. Leave it empty for SaaS senders that rotate their address ranges and rely on the bearer token
or HMAC signature instead ([Secure webhooks](./secure-webhooks.md)). A list whose entries are all invalid admits
nobody, and the editor flags an invalid entry.

## Settings reference

| Variable | Default | Meaning |
|---|---|---|
| `NETWORK_ALLOW_UI`, `NETWORK_ALLOW_API`, `NETWORK_ALLOW_WEBHOOK`, `NETWORK_ALLOW_PUBLIC`, `NETWORK_ALLOW_MCP_GATEWAY`, `NETWORK_ALLOW_METRICS` | unset (open) | Addresses allowed on each scope |
| `NETWORK_ALLOWLIST_MODE` | `enforce` | `report` admits and records would-be refusals |
| `NETWORK_BREAK_GLASS_CIDRS` | loopback | Always admitted on UI and API, audited and alerted; `none` turns it off |
| `MCP_GATEWAY_CLIENT_CERT_HEADER` | unset (off) | Header a TLS proxy forwards the verified client certificate in |
| `MCP_GATEWAY_CLIENT_CERT_PROXIES` | `TRUST_PROXY` list | Proxies allowed to set that header |

In a cluster, give every replica (API, webhook and worker replicas) the same values; the lists are read at startup.

## Related

- [Environment: TRUST_PROXY](../getting-started/environment.md)
- [MCP gateway](../product/mcp-gateway.md)
- [Secure webhooks](./secure-webhooks.md)
- [Cluster operations](../operations/cluster.md)
