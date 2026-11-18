---
title: "Entity service: names and addresses with a local model"
description: "Run l2m-ner, the optional service that finds person names, places and street addresses with a local model: setup, model pull, air-gapped builds, sizing."
---

# Entity service (l2m-ner)

**l2m-ner** is an optional HTTP service that finds person names, places and street addresses in text with a small
local model. It answers the [entity endpoint contract](#endpoint-contract), which the names-and-addresses check of
content rules (`data.entities`, see [Names, locations and street addresses](../product/content-rules-engine.md#names-locations-and-street-addresses))
can use in place of its built-in rules. It finds names without a cue and places the rules do not list, at the cost
of a second container and a CPU model.

It is off by default: nothing starts it, and nothing in L2M needs it. The image and the repository contain **no model
weights**. You download the model yourself from its publisher, accept its licence, and keep it in a volume.

## The model

| | |
| --- | --- |
| Model | `knowledgator/gliner-pii-base-v1.0`, GLiNER-PII base v1.0, the publisher's 8-bit ONNX export (196 MiB) |
| Publisher | Knowledgator (`https://huggingface.co/knowledgator/gliner-pii-base-v1.0`) |
| Licence | Apache-2.0. The encoder it builds on, `microsoft/deberta-v3-small`, is MIT. |
| Training data | Not disclosed by the publisher. The model card names only the evaluation set. |
| Pinned as | A fixed revision, with the URL, size and SHA-256 of every file, in [`apps/ner/models.json`](https://github.com/TensorGreed/ai-orchestrator/blob/main/apps/ner/models.json) |
| Languages | English |

`models.json` is the only list of models the service and the CLI accept. Each entry also holds the model's prompts and
score thresholds (calibrated on the names-and-addresses benchmark) and its benchmark floors. The service refuses a
model folder whose files do not match the manifest.

Because the training data is not disclosed, judge the model by its measured results on your own text before you rely
on it. [Accuracy](#accuracy) has the benchmark numbers and their weak spots.

## Run it with Docker Compose

The root `docker-compose.yml` has a `ner` profile. Pull the model into the `l2m-ner-models` volume first with the
`ner-models` service (it prints the licence; `--accept-licence` accepts it):

```bash
docker compose run --rm ner-models pull --accept-licence
```

`ner-models` runs `l2m-ner models …` (`list`, `pull`, `verify`) and is the only service that writes the volume or
reaches the internet.

Then start the stack with the profile and point the API at the service:

```bash
CONTENT_RULES_NER_ENDPOINT=http://ner:8000 docker compose --profile ner up -d --build
```

The `ner` service publishes no port and sits on an internal network (`ner-internal`) shared only with the API
services, so it can neither be reached from outside nor connect out. It mounts the model volume read-only, has a
read-only root filesystem, and runs with no capabilities and `no-new-privileges`. To require a bearer token, set
`L2M_NER_TOKEN` (16 or more printable characters) for both commands; the compose file passes it to l2m-ner as
`NER_TOKEN` and to the API as the endpoint token (an environment value shows in `docker inspect`; outside compose,
prefer `NER_TOKEN_FILE`). Without the profile, nothing starts.

Until a model is in the volume, the service starts anyway: `GET /health` reports `ready: false` with the pull
command, entity requests get `503 not_ready`, and the service looks for the model again every 15 seconds. A pull
into a running stack is picked up without a restart.

## Run the image on its own

```bash
docker volume create l2m-ner-models
docker run --rm -v l2m-ner-models:/models ghcr.io/tensorgreed/ai-orchestrator-ner:<tag> models pull --accept-licence
docker run -d --name l2m-ner --read-only --tmpfs /tmp --cap-drop ALL -v l2m-ner-models:/models:ro -e NER_TOKEN_FILE=/run/secrets/ner-token \
  -v "$PWD/ner-token:/run/secrets/ner-token:ro" -p 127.0.0.1:8000:8000 ghcr.io/tensorgreed/ai-orchestrator-ner:<tag>
```

The image is Debian slim (glibc), runs as the unprivileged `node` user, has a `HEALTHCHECK` on `/health`, and is
signed and attested like the other release images ([Verify a release](./verify-a-release.md)). It carries the ONNX
Runtime binary for its own platform only; ONNX Runtime's licence and third-party notices are in
`/usr/share/doc/l2m-ner`.

## Pull, verify and list models with the CLI

The `l2m` CLI manages the model folder outside a container too:

```bash
l2m models list                                    # models in the manifest, their licence, and whether they are pulled
l2m models pull --dir ./ner-models                 # shows the licence and asks you to type "yes"
l2m models pull --dir ./ner-models --accept-licence # for scripts
l2m models verify --dir ./ner-models               # re-checks every file's size and SHA-256
```

`--dir` defaults to `NER_MODEL_DIR`, then `./ner-models`. A pull downloads only from the URLs in the manifest, over
HTTPS, hashes each file while it streams, stops a download larger than the manifest says, and renames a file into
place only once its SHA-256 matches. Files that already match are not downloaded again. Without a terminal and
without `--accept-licence`, `pull` downloads nothing and exits with code 2.

## Air-gapped installs

The service never connects anywhere at run time: it reads the model from its volume and answers requests. Only
`models pull` downloads, and the image build needs the npm registry (or your mirror of it). On a disconnected network:

1. **The model.** On a connected machine, run `l2m models pull --dir ./ner-models --accept-licence`, or download each
   URL in `apps/ner/models.json` yourself and check it with `sha256sum` against the manifest. Copy the folder (it holds
   one subfolder per model, `knowledgator__gliner-pii-base-v1.0`) into the volume or directory the service mounts at
   `/models`, then run `l2m models verify --dir <folder>` (or `docker run … models verify`) there.
2. **The image.** Either `docker pull` the release image on a connected machine, check it as
   [Verify a release](./verify-a-release.md) shows, and move it with `docker save` and `docker load`; or build it
   yourself from the repository with access to an npm mirror:

   ```bash
   docker build -f apps/ner/Dockerfile -t l2m-ner:local .
   ```

   The build installs only l2m-ner's locked dependencies (`pnpm install --frozen-lockfile`) and does not run
   ONNX Runtime's install script, which fetches GPU libraries; it never downloads a model.

ONNX Runtime's usage telemetry is switched off (`ORT_DISABLE_TELEMETRY=1`, set in the image and by the service
itself).

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `NER_HOST` | `127.0.0.1` (`0.0.0.0` in the image) | Address to listen on; the service logs a warning at start when it listens beyond loopback without a token |
| `NER_PORT` | `8000` | Port |
| `NER_MODEL_DIR` | `./ner-models` (`/models` in the image) | Folder that holds the pulled models |
| `NER_MODEL` | the manifest's default | Model id to load |
| `NER_TOKEN` / `NER_TOKEN_FILE` | none | Bearer token for `POST /v1/entities` (16 to 4096 printable characters, no spaces); set one, not both |
| `NER_WORKERS` | `1` | Worker threads, each with its own copy of the model (0 runs on the main thread; at most 16) |
| `NER_THREADS` | `2` | ONNX Runtime threads per worker |
| `NER_MAX_QUEUE` | `16` | Requests in progress (and, separately, request bodies being read) before new ones get `429` |
| `NER_REQUEST_TIMEOUT_MS` | `60000` | Time limit per request; a slower one gets `503 timeout` and its work is stopped |
| `NER_MAX_TEXT_CHARS` | `20000` | Longest text accepted |
| `NER_MAX_REQUEST_CHARS` | `200000` | All texts of one request together |
| `NER_MAX_BODY_BYTES` | `2097152` | Largest request body |
| `NER_MODEL_RETRY_MS` | `15000` | How often to look for a missing or refused model |

Fixed limits: a request body must arrive within 15 seconds, and at most 256 connections are open at once.
A blank value counts as unset. A value that does not parse stops the service at start with the variable's name (never
its value).

## Endpoint contract

The full contract is [`apps/ner/openapi.json`](https://github.com/TensorGreed/ai-orchestrator/blob/main/apps/ner/openapi.json)
(OpenAPI 3.1; also in the image at `/app/apps/ner/openapi.json`). Any service that answers it can stand in for
l2m-ner.

```http
POST /v1/entities
Authorization: Bearer <token>        (when the service has one)
Content-Type: application/json

{ "texts": ["Ship to Maria Gonzalez, 1209 Oak Avenue, Springfield, IL 62704."],
  "labels": ["person_name", "location", "street_address"],
  "language": "en",
  "threshold": 0.8 }
```

```json
{ "results": [ { "entities": [
    { "start": 8, "end": 22, "label": "person_name", "score": 0.994 },
    { "start": 24, "end": 62, "label": "street_address", "score": 0.907 } ] } ],
  "model": { "id": "knowledgator/gliner-pii-base-v1.0", "version": "61726e0ad791-72adb63c", "sha256": "0514c8fd…" } }
```

- `texts`: 1 to 64 strings. `results` has one entry per text, in the same order.
- `labels`: any of `person_name`, `location`, `street_address`, each once. Only those labels come back.
- `language`: a language the model lists (`en`); another answers `400 unsupported_language`.
- `threshold` (optional, 0 to 1, default 0.8): the lowest score returned.
- `start` and `end` are UTF-16 code unit offsets (JavaScript string indices), end exclusive. Entities of one text do
  not overlap.
- `model.version` changes whenever the model files or the service's reading of them (prompts, thresholds, windows)
  change; `model.sha256` is the ONNX file's checksum.

`GET /health` needs no token and answers `{ "ok": true, "ready": true, "model": {…} }` once the model is loaded, or
`ready: false`, `model: null` and a `message` while it is missing or loading. It answers 503 with `ok: false` only when
the model folder was refused (a checksum that does not match) or failed to load. Messages name the files at fault but
not paths or loader errors; those are in the service log.

The service checks the model files once more before it starts each model worker, including a replacement for a worker
that stopped: if any file changed since it was hashed, the service stops the model and hashes the folder again.
Mount the folder read-only for the service (as the compose file does) so only `models pull` can change it.

Errors are `{ "error": { "code", "message" } }`: `400 bad_request` (the message names the field and the rule, never
a value), `401 unauthorized`, `404`, `405`, `413 too_large`, `415`, `429 busy` (with `Retry-After`),
`503 not_ready`, `503 timeout` and `503 failed`. Neither errors nor logs ever contain request text: a log line holds
the route, status, duration, and the counts of texts, characters and entities.

### Scores

Scores are calibrated per class: **0.8 is the score at which each class reached its benchmark cut-off**, whatever
the model's raw score there was, and scores above it spread up to 1. So one threshold means the same for names, places
and addresses, and a check's per-class minimum scores apply directly. Asking for a lower `threshold` returns more
findings below the calibrated cut, down to a raw score of 0.15.

### How text is read

Text is split into words (letters and digits, with hyphenated words kept whole, and each other character on its own)
and read in windows of up to 128 words that overlap by 16; an entity cut by a window's edge is taken from the window
that holds it whole. The model reports a street line, a town, a state, a postcode and a country separately; l2m-ner
joins a street line that has a house number with the parts that follow it on the same or the next line, a unit before
it (`Flat 4, …`) and a postcode after it, into one `street_address`. Parts with no street line become `location`
(a postcode alone is never reported). A street name without a number, a PO box or a unit alone is not an address.
Titles (`Dr.`, `Mrs`) and suffixes (`Jr.`) are left out of a name.

## Sizing

Each worker holds one copy of the model. Measured with the default model on a shared 20-core arm64 host,
one worker, through HTTP:

| | 1 thread | 2 threads (default) | 4 threads |
| --- | --- | --- | --- |
| A 760-word text (4,900 characters), p50 | 1.37 s | 0.73 s | 0.71 s |
| A benchmark item (one or two sentences), p50 | | 19 to 30 ms | 12 ms |
| Memory (resident) | about 650 MiB | about 650 MiB | about 650 MiB |

- **Disk:** the model is 196 MiB; the image is about 290 MiB.
- **Throughput:** about 6,500 characters a second per worker at 2 threads. More threads stop helping past 2 to 4;
  for more throughput add workers (`NER_WORKERS`, each with its own copy of the model in memory) or replicas, and
  give each `workers × threads` cores.
- **x86:** the [opt-in model workflow](#accuracy) records x86 timings for the same texts in its run summary.
- **Length limits.** Time grows linearly with text length. A check that runs inline, before a model or tool call,
  waits for the answer: keep the check's `maxChars` near **6,000 characters** (well under a second at 2 threads) for
  those, and leave the 20,000 default for document scans and simulations, which are not on a run's critical path.
  Longer text fails the check rather than being cut, so the rule set's failure policy decides.

## Accuracy

The names-and-addresses benchmark (`packages/guard-sdk/corpus/entities`, 420 labelled texts, a main split and a
held-out split) measured through the service:

| Class | Split | Precision | Recall | Floor (precision / recall) |
| --- | --- | --- | --- | --- |
| person_name | main | 1.00 | 0.91 | 0.97 / 0.876 |
| person_name | held-out | 1.00 | 0.75 | 0.97 / 0.723 |
| location | main | 0.95 | 0.90 | 0.92 / 0.875 |
| location | held-out | 0.69 | 0.78 | 0.66 / 0.754 |
| street_address | main | 0.99 | 0.92 | 0.959 / 0.887 |
| street_address | held-out | 1.00 | 0.92 | 0.97 / 0.887 |

Precision and recall count a finding that overlaps a labelled span. The built-in rules reach a recall of 0.83 for
names, 0.49 for places and 0.68 for addresses on the same benchmark. Weak spots: on the held-out split the model reads
some product, font and brand names as places, misses some German addresses, and flags 7 of 28 look-alike texts.

The floors are in `benchmarkFloors` of `apps/ner/models.json`, set 0.03 under the measured values (capped at 0.97).
To measure a running service yourself:

```bash
L2M_NER_TOKEN=… l2m guard benchmark --entities --endpoint http://localhost:8000
```

It reads the model from `/health`, gates on that model's floors when the manifest lists it (same id and ONNX
checksum). For a model the manifest does not list it exits 1, since there is nothing to gate on; add `--report-only` to
measure it anyway. A token is sent only over https or to `localhost`. The workflow `.github/workflows/ner-model.yml` does the same on x86 in CI: it
runs only by hand, or weekly when the repository variable `L2M_NER_MODEL_WEEKLY` is `true`, and is the only workflow
that downloads the model. Change the floors in a pull request with the run that measured them.
