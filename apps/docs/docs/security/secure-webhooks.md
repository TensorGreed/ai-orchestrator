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
- `403`: invalid signature or replay
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
