---
description: "What L2M records for every MCP tool call: timings, errors, tokens and an allow-list argument summary with keyed hashes. What it keeps, and how to switch it off."
---

# MCP tool-call telemetry

L2M records one telemetry row for every MCP tool call: calls a workflow makes (agent tool calls and MCP Tool nodes), calls MCP clients send through the [gateway](./mcp-gateway.md) and calls a builder makes from the playground. The [control plane](./mcp-control-plane.md) builds its call counts, error rates, latency, cost and recent calls from these rows.

## What a row holds

- the server, tool, node, workflow and execution the call belongs to, and where it came from (`workflow`, `gateway` or `playground`, plus the client for gateway calls);
- when it started, how long it took, whether it failed (the error text is redacted and cut to 500 characters) and why it was refused, if the runtime refused it;
- the model tokens and cost of the turn that asked for it, and any sampling the server requested;
- a **safe summary of the call's arguments**;
- the **role** and **subject source** the call ran under (`user`, `owner`, `fallback` or `client`, as in the [tool policy](./mcp-tool-policy.md)) and the **project**.

The argument summary, role and project are what lets L2M later suggest and test tool rules from real runs without keeping the arguments themselves.

## The argument summary

The summary describes each argument by its path (`state`, `labels[]`, `files[].path`). It is an **allow-list**: a value is stored as it is only when it is safe by construction. Every other value is stored as its shape plus a **keyed hash**, so equal values can still be counted and compared, but not read back.

### What is kept as it is

| The argument holds | Kept as it is |
| --- | --- |
| null, or a boolean | The value. |
| A number whose integer part has at most six digits | The value, rounded to four decimals, with the smallest and largest seen. Under a location key (`lat`, `lng`, `lon`, `latitude`, `longitude`, `geo`) it is rounded to one decimal. |
| A value of at most 64 characters the tool's input schema lists (`enum` or `const`) at that path | The value, as the schema writes it. |
| A short token: lower-case ASCII letters, digits, `_`, `.` and `-`, starting with a letter, at most 32 characters, such as `open`, `main`, `us-east-1` | The value, when it has no run of four digits, does not end like a domain or a `first.last` name (`john.smith`, `john.smith1`, `example.com`) and does not look random. |

A token looks random when it starts with a known key prefix (`sk-`, `pk_`, `ghp_`, `xoxb-`, `glpat-`, `AKIA`, ...) or any part between `_`, `-` and `.` is longer than 16 characters, is 12 or more hex characters, mixes letters and digits over 8 or more characters, or is 8 or more letters with fewer than one vowel in four. Text is compared after Unicode NFKC normalisation, and digits of every script count as digits, so full-width and other-script numbers are not tokens.

None of this applies on a **sensitive path**: when the argument's key, or any key above it, is sensitive. Keys are split into words on case changes, `_`, `-`, `.` and digits, and a word is sensitive when:

- it **contains** a sensitive stem anywhere, so joined and all-lower-case keys count too (`firstname`, `userid`, `emailaddress`, `phonenumber`, `accountno`, `zipcode`). The stems are credentials (`pass`, `password`, `passcode`, `passphrase`, `secret`, `token`, `key`, `auth`, `cred`, `cookie`, `session`, `otp`, `mfa`, `pin`, `nonce`, `signature`, `bearer`, `jwt`, `private`, `cert`), codes and identifiers (`code`, `postal`, `zip`, `verification`, `verify`, `security`, `ssn`, `iban`, `card`, `cvv`, `cvc`, `account`, `acct`, `passport`), people (`name`, `firstname`, `lastname`, `surname`, `fullname`, `nickname`, `givenname`, `user`, `login`, `handle`, `owner`, `author`, `assignee`, `reviewer`, `customer`, `patient`, `employee`, `member`, `person`, `contact`, `recipient`, `sender`, `email`, `mail`, `phone`, `mobile`, `address`, `addr`, `street`, `postcode`, `birth`) and people's words (`body`, `message`, `text`, `content`, `query`, `search`, `keyword`, `prompt`, `comment`, `note`, `description`, `title`, `subject`, `summary`);
- or it **is** one of the short words `pw`, `pwd`, `sid`, `sig`, `tax`, `tel`, `dob`, `to`, `cc`, `bcc`, `from`, `q`, `uid`, `rcpt`, `nm` or `mrn` (also with a plural `s`).

Matching inside words over-matches on purpose: `filename`, `hostname`, `country_code`, `context` and `wildcard` are sensitive too, so their values are hashed. The one word exempt from the stems is `namespace` (a deployment namespace such as `kube-system`); only the key is exempt, so its values still go through the token, random-looking and handle checks and are hashed when they fail them. A sensitive path keeps only shape and hashes, whatever the schema says: strings, booleans and numbers of any size, which keep only their order of magnitude.

The one exception is a model's token budget: a number directly under the key `max_tokens`, `max_output_tokens`, `max_completion_tokens`, `token_limit` or `num_tokens` (exactly, in any case) is kept under the normal number rules, unless a key above it is sensitive. Strings under those keys stay hashed.

### Prefixes

Outside sensitive paths, an identifier that is not kept as it is can keep a stable prefix, for starts-with rules:

| The argument holds | Prefix |
| --- | --- |
| A repository such as `octo-org/hello-world` | The owner: `octo-org/`. The owner can be a person's handle. |
| A URL | Its scheme and host: `https://api.github.com`. An IP address becomes `ip`; a host with more than one label before its domain keeps only the domain (`https://a.b.example.com` becomes `https://example.com`); shared hosting keeps only its suffix (`https://*.github.io`). Never the path, query, port or credentials. |
| An email address | Its domain, reduced the same way: `@example.com`. Never the local part. |
| A file path | Its root and at most one more segment, never the last one: `/srv/`. A home directory (`/home/<user>`, `/Users/<user>`, `C:\Users\<user>`, `/root`) becomes `~/`, so `/home/jdoe/src/app.ts` gives `~/src/`. |

### What is hashed

Every other string, number and boolean keeps:

- its type and, for strings, a length bucket (`1-8`, `9-32`, `33-128`, ...);
- for numbers with seven or more integer digits or on a sensitive path, the order of magnitude (`mag`, the largest `floor(log10(|n|))` seen);
- a **keyed hash**: HMAC-SHA-256 of the NFKC-normalised value, cut to 16 bytes and written in base64url. The key is always derived from `SECRET_MASTER_KEY_BASE64` with HKDF and its own label, the same way as the [production capture](./production-capture.md) surrogate key, and is never stored. The API does not start without the master key. Rotating it changes every hash, so rows written before a rotation no longer match new rule values. Strings over 2,048 characters keep no hash.

A value hashed with the same key gives the same hash, so a rule's comparison value can be matched against recorded calls without the calls keeping the value.

Object keys are kept in the path only when they are plain names: an ASCII letter followed by letters, digits, `_` or `-`, at most 32 characters, no run of four digits and not random-looking. The random check runs on the whole key, so hex digests, UUIDs and ids that mix letters and digits (`a1b2c3d4e5f6g7h8`) are hashed, and so are keys that read like random mixed-case letters or have few vowels (`XMLHttpRequest` included). Any other key (an email, an id, a number used as a key) is written `<k:HASH>`.

Every value and key is also scanned with the same detectors as [production capture](./production-capture.md) masking, including URL-encoded and JSON-escaped forms. The data classes they find (`card_number`, `email`, `credential`, ...) are listed for the path, and a flagged value is never kept as it is. Large or deeply nested arguments are summarised up to fixed limits (depth, paths, array items, characters scanned); a value that could not be scanned within them is never kept as it is, and the summary is marked `truncated`.

For example, the arguments

```json
{ "owner": "octo-org", "repo": "octo-org/hello-world", "state": "open", "per_page": 50,
  "path": "/home/jdoe/src/app.ts", "account_id": 12345678,
  "title": "Crash when saving", "body": "Card 4111 1111 1111 1111 was charged twice" }
```

are summarised as (hashes shortened)

```json
{ "v": 2, "fields": {
  "account_id": { "type": "number", "mag": 7, "hashes": ["SPFBgtsm…"] },
  "body": { "type": "string", "hashes": ["c0Esx-nM…"], "classes": ["card_number"], "len": "33-128" },
  "owner": { "type": "string", "hashes": ["mlsb-iLo…"], "len": "1-8" },
  "path": { "type": "string", "hashes": ["-Ky9LH7b…"], "prefixes": ["~/src/"], "len": "9-32" },
  "per_page": { "type": "number", "values": [50], "min": 50, "max": 50 },
  "repo": { "type": "string", "hashes": ["N4YPel47…"], "prefixes": ["octo-org/"], "len": "9-32" },
  "state": { "type": "string", "values": ["open"] },
  "title": { "type": "string", "hashes": ["s6GMfE1K…"], "len": "9-32" } } }
```

### Limits

The summary keeps no free text, and detected personal data only by class and hash, but short plain values can still be kept. Know these before you rely on it:

- a short lower-case token under an ordinary key (`ref`, `label`, `kind`) is kept, including joined words (`john_smith`) and word-like passwords (`hunter2`);
- numbers below a million are kept, so ids, codes and date parts under ordinary keys (`year`, `day`, `mrn`) are visible;
- values a tool's schema lists (`enum` or `const`, up to 64 characters) are kept as the schema writes them;
- an object key is kept as a path segment, so a map keyed by names (`scores.alice`, `scores.JohnSmith`) keeps the names, and a short random mixed-case key can pass the random check;
- repository owners, email domains, URL hosts and a path's first directory are kept as prefixes, and can be a person's handle or personal domain;
- a keyed hash cannot be reversed without the key, but anyone holding the master key can test guesses against it.

If your tools take personal data in such places, switch summaries off.

## Who can see it

Admins see each recent call's summary and role in the tool drawer of **MCP → Tools** (`GET /api/mcp/tools`, `recentCalls[].argsSummary`); builders see the calls without them. Audit bundles of a run include its telemetry rows, summaries included. A bundle also holds the run's full node outputs, raw tool arguments included, so the summaries add nothing to what anyone who can read a run's bundle already sees.

The project on a row is a label taken when the call ran, not a link: after a project is deleted its rows keep the old project id.

## Retention

Telemetry rows, summaries included, are pruned with execution history (`EXECUTION_HISTORY_RETENTION_DAYS`, default 30 days) and deleted with their run.

## Switching it off

Argument summaries are on by default and need no setting. To stop recording them, set

```bash
MCP_TOOL_ARGUMENT_SUMMARIES=false
```

and restart the API. New rows then keep no summary, role, subject source or project; everything else is recorded as before. Rows written earlier keep their summaries until retention removes them.
