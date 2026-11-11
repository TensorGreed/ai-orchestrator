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
| UI | `NETWORK_ALLOW_UI` | `/api/*` with a session cookie or no credential: the studio's calls, the MCP OAuth callback, and always sign-in, registration, SSO, OIDC and MFA (`/api/auth/*` except `api-keys`, `me` and `sso`) |
| API | `NETWORK_ALLOW_API` | `/api/*` with an API key (`Authorization: Bearer ao_…`), including `/api/webhooks/execute` and `/api/triggers/manual/*` |
| Webhook | `NETWORK_ALLOW_WEBHOOK` | `/webhook/*`, `/webhook-test/*`, provider webhooks (`/api/webhooks/slack/*` and the others), `/api/mcp-server/*` (with or without an API key) |
| Public | `NETWORK_ALLOW_PUBLIC` | Forms (`/api/forms/*`), chat (`/api/chat/*`), `/widget.js`, `/helper-chat` |
| MCP gateway | `NETWORK_ALLOW_MCP_GATEWAY` | `/mcp/*` and the `/v1/*` AI gateway, which takes the same client tokens |
| Metrics | `NETWORK_ALLOW_METRICS` | `/metrics`, `/api/docs`, `/api/openapi.json` |

`/health`, `/ready` and the SAML metadata (`/api/auth/saml/metadata`, which the identity provider fetches) are never
checked, so health checks and probes keep working. A request with both a session cookie and an API key must pass both
the UI and the API list, since the server accepts either credential. A session cookie always brings the UI list: an
`Authorization` header that is not an API key (`Bearer x`, `Basic …`) does not make a request API traffic.

The workflow-as-MCP endpoints (`/api/mcp-server/*`) are checked against the webhook list only, also when the caller
sends an API key, because they are how outside callers reach published workflows. To keep API-key callers there on
your API ranges, put those ranges in `NETWORK_ALLOW_WEBHOOK` as well, or route `/api/mcp-server/` only from those
networks at your proxy.

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
- Whenever `TRUST_PROXY` is set, the API port must be reachable **only** through the proxy. A hop count or a broad
  range (such as a cluster's pod range) trusts `X-Forwarded-For` from anyone who can connect to the port, so a client
  that reaches it directly picks the address it is checked by. In Kubernetes, add a NetworkPolicy that admits only the
  ingress controller to the API pods.

The shipped `docker-compose.prod.yml` sets `TRUST_PROXY=1` (override it with your own `TRUST_PROXY`): its nginx is
the single hop in front of the API, and the API port is only exposed inside the compose network. The development
`docker-compose.yml` leaves it unset, because it publishes port 4000 on the host.

::: info Upgrading: the audit address
Audit events now record the address the API counts the request from (`request.ip`). Earlier releases read the first
`X-Forwarded-For` entry directly, which any client could write. Behind a proxy with `TRUST_PROXY` unset, the audit
`ipAddress` is now the proxy's address; set `TRUST_PROXY` to record the client's. Field names are unchanged.
:::

A list entry that is not an address or range refuses to start, naming the setting and the entry:

```text
Invalid environment configuration: NETWORK_ALLOW_API entry "10.0.0.300/8" is not an IP address or CIDR range
```

## What a refused request sees

A refused request gets `403` with a fixed body, `{"error":"Access from this address is not allowed"}`, or on
`/mcp/*` a JSON-RPC error with code `-32001` and the same message, or on `/v1/*` an OpenAI-format error with code
`access_denied` and the same message. The body never names the list or the address. The check runs before rate limiting, so refused requests use no rate-limit budget.

Refusals are recorded:

| Record | When |
|---|---|
| Audit `network.request_denied` | A list refused a request. At most once a minute per address and scope (per client or trigger for object lists), and at most 60 a minute per scope whatever the address (the 61st is a summary row with `scopeCapReached`), with the scope, the list, the method and the path (never the query). |
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
wrong. A break-glass range must match both the connecting address and the address the request is counted from: a
loopback address written into `X-Forwarded-For` never counts, even from a trusted proxy, and a proxy on the same host
connecting over loopback does not make its outside clients break-glass. Every admission through it is audited as `network.break_glass_used` and raises the `network.break_glass_used`
notification (at most once every 10 minutes per address); pick **Break-glass access used** on a notification channel,
and channels set from the environment get it automatically. Set `NETWORK_BREAK_GLASS_CIDRS=none` to turn it off.

Break-glass never opens the webhook, public, gateway or metrics scopes. Since the lists live in the environment,
fixing a wrong one is a change to the environment and a restart, never a database edit.

Network break-glass admits an address; it does not sign anyone in. When no admin can sign in at all, use
[break-glass sign-in](./auth-rbac.md#break-glass-sign-in): a one-time link minted on the host. Its confirm request
and session are still checked against the allowlists, so open it from an allowed or break-glass address.

::: warning Behind a proxy on the same host
If the proxy reaches the API over loopback and `TRUST_PROXY` is off, every request is counted from `127.0.0.1` and
break-glass admits all of them. Set `TRUST_PROXY` so the client's own address is checked.

In the production compose file the API port is not published, so break-glass works only from inside the API
container: `docker compose exec api-1 wget -qO- http://localhost:4000/...`. The compose file sets `TRUST_PROXY=1`
because nginx is its single hop; do not publish port 4000 while it is set.
:::

## Per-client lists and certificates (MCP gateway)

These settings belong to the client's token, so they apply on both endpoints that accept it: `/mcp/*` and the
[`/v1` AI gateway](../product/ai-gateway.md).

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
once a minute per endpoint, client, address and reason: `none`, `untrusted`, `invalid`, `expired` or `mismatch`; events
from `/v1/*` carry `endpoint: "ai_gateway"`). A call from an address outside the client's list gets the `403` above.

### How the certificate reaches L2M

The API does not terminate TLS. The proxy in front of it verifies the client certificate against your client CA and
forwards it in a header. Two settings turn this on:

| Setting | Meaning |
|---|---|
| `MCP_GATEWAY_CLIENT_CERT_HEADER` | The header the proxy forwards the certificate in. Unset = off (a client with fingerprints then cannot connect, so they cannot be saved). |
| `MCP_GATEWAY_CLIENT_CERT_PROXIES` | Addresses of the proxies allowed to set that header. Required with the header, and never taken from `TRUST_PROXY`. |

The header is honoured only when the connection itself comes from one of those proxies (the socket address, not the
forwarded one); from anywhere else it is ignored, so a client cannot present a certificate by sending the header
itself. Your proxy must also **overwrite** the header on every request rather than pass a client's value through or
append to it; a header that holds more than one certificate is refused as `invalid`. The API reads a PEM certificate, URL-encoded PEM (nginx `$ssl_client_escaped_cert`, ingress-nginx, AWS ALB), an Envoy
`x-forwarded-client-cert` element with `Cert="…"`, or base64 DER, and checks its validity dates again.

::: warning Keep the proxy list narrow
A certificate is not a secret: anyone who has seen it (in a log, a TLS capture or a shared bundle) can copy it into
the header. The pin is only as strong as the rule that only the verifying proxy can set the header. List just that
proxy's addresses (the ingress controller pods, not the cluster's pod range), and add a NetworkPolicy, or a firewall
rule, so only the proxy can reach the API port. Any other proxy in front of the API, such as the `web` container's
nginx, must clear the header (`proxy_set_header X-SSL-Client-Cert "";`) if it can reach the API from a listed address.
:::

**nginx.** Verify client certificates where nginx terminates TLS and forward them on `/mcp/`. Give `/v1/` a `location`
with the same settings: a location that does not set the header passes a client's own value through, from an address
the API trusts.

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
MCP_GATEWAY_CLIENT_CERT_PROXIES=172.18.0.10     # the nginx container's address only (give it a fixed one)
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
  MCP_GATEWAY_CLIENT_CERT_PROXIES: "10.0.12.0/28"  # the ingress controller pods only, not the whole pod range
```

```yaml
# Only the ingress controller may reach the API pods, so no other pod can write the certificate header.
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: l2m-api-from-ingress
spec:
  podSelector:
    matchLabels:
      app.kubernetes.io/component: api
  policyTypes: [Ingress]
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: ingress-nginx
      ports:
        - port: 4000
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
| `NETWORK_BREAK_GLASS_CIDRS` | loopback | Always admitted on UI and API (matched on the connecting address too), audited and alerted; `none` turns it off |
| `MCP_GATEWAY_CLIENT_CERT_HEADER` | unset (off) | Header a TLS proxy forwards the verified client certificate in |
| `MCP_GATEWAY_CLIENT_CERT_PROXIES` | unset (required with the header) | Proxies allowed to set that header |

In a cluster, give every replica (API, webhook and worker replicas) the same values; the lists are read at startup.

## Related

- [Environment: TRUST_PROXY](../getting-started/environment.md)
- [MCP gateway](../product/mcp-gateway.md)
- [Secure webhooks](./secure-webhooks.md)
- [Cluster operations](../operations/cluster.md)
