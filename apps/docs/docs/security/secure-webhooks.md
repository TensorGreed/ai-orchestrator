---
title: "Secure webhooks: bearer tokens, HMAC and replay checks"
description: "Secure L2M webhook triggers with bearer tokens or HMAC-SHA256 signatures, replay windows and idempotency keys, with the signing format and error responses."
---

# Secure Webhooks

Webhook trigger routes:

- `ANY /webhook/:path`
- `ANY /webhook-test/:path`

Compatibility API route:

- `POST /api/webhooks/execute`

## Webhook auth modes

- `none`
- `bearer_token`
- `hmac_sha256`

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
