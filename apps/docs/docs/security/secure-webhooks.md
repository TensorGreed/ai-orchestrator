---
title: "Secure webhooks: bearer tokens, HMAC and replay checks"
description: "Secure L2M webhook triggers with bearer tokens or HMAC-SHA256 signatures, replay windows and idempotency keys, with the signing format and error responses."
---

# Secure Webhooks

Webhook trigger routes:

- `ANY /webhook/:path`
- `ANY /webhook-test/:path` (runs the draft; needs a signed-in session or an API key, see below)

Compatibility API route:

- `POST /api/webhooks/execute`

## Webhook auth modes

- `none`
- `bearer_token`
- `hmac_sha256`

## Public triggers get a warning on save

A webhook without `bearer_token` or `hmac_sha256`, a Form Trigger without `session`, a Chat Trigger without `session`
or `bearer`, and an Expose as MCP Tool trigger without `bearer` can be called by anyone who can reach the API (unset
counts as public). When you save a workflow with one that is on, the editor
lists it in one line under the save notes (for example "Public webhook: anyone who can reach this server can call
it."). The warning never blocks a save or a run, and a trigger that is switched off gets none. The same notes come from
`POST /api/workflows/:id/validate` as warnings with the code `public_entry`.

A new Expose as MCP Tool trigger starts with auth mode **Bearer token**: its REST route refuses every call until you
pick the secret that holds the token (it answers `401` with `"code": "token_not_set"`). MCP clients reach the tool through a toolset with their own client token either
way. A trigger saved without an auth mode stays public.

## An Auth Mode the trigger does not know

A webhook, form, chat or MCP trigger whose `authMode` is set to a value it does not know (a typo in imported JSON, for
example) refuses every call with `500` and `"code": "unknown_auth_mode"`, instead of treating it as public. Pick an
Auth Mode in its settings.

## App triggers (Slack, GitHub, Stripe, Telegram, Discord)

`/api/webhooks/<app>/:workflowId` takes a call only when the provider's own signature or token checks out:

- Each trigger needs its secret (Slack, Stripe: signing secret; GitHub: webhook secret; Telegram: secret token,
  sent in `X-Telegram-Bot-Api-Secret-Token` when you register the webhook with `secret_token`; Discord: public key).
- An unknown workflow id, a workflow without that trigger, a trigger with no secret set, and a call whose signature,
  token or timestamp does not check out all get the same plain `404` (`{"error": "Not found"}`). The route never says
  which workflow ids exist or which triggers lack a secret. Check the provider's delivery log for a `404` when you set
  one up: it usually means the secret does not match.
- Once the signature checks out: a trigger switched off (**Live calls** under **More**) answers `404` with
  `"code": "trigger_off"`, a deactivated gated workflow `409`, and a version with unfinished settings `409`
  `workflow_unfinished`.

## Production webhook answers

To anyone not signed in, `/webhook/:path` answers a path that does not exist, and a method the path does not take,
with the same plain `404` (`{"error": "No webhook endpoint matches this path and method"}`): it lists no endpoints and
no methods. A signed-in person (or an API key) who may run a workflow on that path gets the detail: `405` with the
methods it takes, or the endpoints of that method they may run.

A webhook switched off with a bearer token or HMAC signature says it is off (`trigger_off`) only to a call that passes
that check; anyone else gets the plain `404`. One with Auth Mode **None** says it is off to anyone who has its path.

## The test URL (`/webhook-test/:path`)

The test URL runs the saved draft, so it is only for people who may edit the workflow:

- A signed-in session from the studio's own page (a link or form on another site is refused: the page's `Origin` or
  `Referer` must be this server or a `WEB_ORIGIN`), or an API key in
  `Authorization: Bearer <key>` or `X-API-Key: <key>`. Use `X-API-Key` when the webhook's own bearer token takes the
  `Authorization` header. A key limited to projects is refused here.
- The caller needs edit access to the workflow. Someone who may only run it gets `403`, and should call `/webhook/:path`.
- Anyone else, and a path that does not exist, gets the same plain `404` that lists no endpoints.
- The webhook's own auth (bearer token or HMAC signature) still applies on top.
- The run is recorded as started by the caller.

## Switched off (`active: false`)

A webhook, form, chat, MCP or app trigger whose node has `active: false` takes no production calls: `/webhook/:path`,
`/api/forms/:path`, `/api/chat/:workflowId`, `/api/mcp-server/:path/*` and the app routes answer `404` with
`"code": "trigger_off"` (a protected webhook and the app routes only once the caller's token or signature checks out),
and the MCP gateway leaves the tool out. `/webhook-test/:path` answers the same `404`. The editor's **Run** and
**Webhook run** still work.
Unset means on, so nodes saved before the setting are unchanged. Starter templates ship with theirs off; the node's
inspector says so in one line with **Turn on**, and **Live calls** under **More** switches it off again.

The switch covers the anonymous entry points. The signed-in run API (`POST /api/webhooks/execute` and
`/api/workflows/:id/execute`, which the editor's runs use) still runs the workflow for an operator, a builder or an API
key with that role. With a release gate, production uses the published version, so turning a trigger on takes effect
once that version is published. An off webhook is also left out of the endpoint lists that `/webhook/` returns with a
`404` or `405`.

## Allowed addresses (optional)

A trigger's `allowedIps` (the **Allowed Addresses** field, one IP or CIDR range per line) limits who can call it;
other addresses get `403` before the auth mode is checked. Empty means any address. The whole webhook scope can be
limited with `NETWORK_ALLOW_WEBHOOK`; see [Network controls](./network-controls.md).

## Replay protection (HMAC mode)

- Requires timestamp header
- Rejects requests outside tolerance window
- Deduplicates replay signatures in short TTL store

## Idempotency

- Optional `Idempotency-Key` handling
- Duplicate request with same payload returns existing result reference
- Conflicting payload for same key returns `409`

## Error contracts

- `401`: missing/invalid auth token
- `403`: invalid signature or replay, or an address outside `allowedIps`
- `409`: idempotency key conflict

## HMAC signing format

Signature is computed from:

```text
timestamp + "." + raw_request_body
```

Then:

```text
hex(HMAC_SHA256(secret, payload))
```
