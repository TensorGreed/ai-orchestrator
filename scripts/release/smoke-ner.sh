#!/usr/bin/env bash
# Starts a built l2m-ner image without a model (the image never contains one) and checks that it works:
#
#   - no model weights (*.onnx) anywhere in the image, and ONNX Runtime binaries for this platform only
#   - it runs as an unprivileged user
#   - /health answers ok with ready=false, model=null and the pull command; the container HEALTHCHECK reports healthy
#   - POST /v1/entities asks for the bearer token (401) and, with it, answers 503 not_ready
#   - `models list` shows the pinned model, its licence and that it is not pulled
#
# Nothing is downloaded: the container runs on an internal network, so a check that reached out would fail.
# Prints the image size. Exits non-zero, with the container logs, on the first failed check.
#
# Usage: smoke-ner.sh <image reference> (run from the repository root)
# Needs: docker, jq, openssl.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <image reference>" >&2
  exit 64
fi
image=$1
run_id="l2m-smoke-ner-$$"
network="$run_id-net"
token="smoke-$(openssl rand -hex 16)"

cleanup() {
  docker rm -f "$run_id" > /dev/null 2>&1 || true
  docker network rm "$network" > /dev/null 2>&1 || true
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  echo "--- l2m-ner container logs (last 40 lines)" >&2
  docker logs --tail 40 "$run_id" >&2 2>&1 || true
  exit 1
}

pass() { echo "ok   $*"; }

# Runs a request from inside the container (node's fetch), so the internal network needs no published port.
call() {
  docker exec -e SMOKE_URL="$1" -e SMOKE_METHOD="${2:-GET}" -e SMOKE_AUTH="${3:-}" "$run_id" node -e '
    const headers = { "content-type": "application/json" };
    if (process.env.SMOKE_AUTH) headers.authorization = `Bearer ${process.env.SMOKE_AUTH}`;
    const body = process.env.SMOKE_METHOD === "POST" ? JSON.stringify({ texts: ["hello"], labels: ["person_name"], language: "en" }) : undefined;
    fetch(process.env.SMOKE_URL, { method: process.env.SMOKE_METHOD, headers, body })
      .then(async (r) => console.log(JSON.stringify({ status: r.status, body: await r.json() })))
      .catch((e) => { console.error(e.message); process.exit(1); });'
}

onnx=$(docker run --rm --entrypoint sh "$image" -c 'find / -xdev -name "*.onnx" 2>/dev/null | head -5')
[ -z "$onnx" ] || fail "the image contains model files: $onnx"
pass "no model weights in the image"

bins=$(docker run --rm --entrypoint sh "$image" -c 'find /app -name onnxruntime_binding.node | wc -l')
[ "$bins" = "1" ] || fail "expected one ONNX Runtime binding for this platform, found $bins"
pass "one ONNX Runtime binary (this platform)"

uid=$(docker run --rm --entrypoint id "$image" -u)
[ "$uid" != "0" ] || fail "the image runs as root"
pass "runs as uid $uid"

docker network create --internal "$network" > /dev/null
docker run -d --name "$run_id" --network "$network" -e NER_TOKEN="$token" "$image" > /dev/null

health=""
for _ in $(seq 1 60); do
  if [ "$(docker inspect --format '{{.State.Running}}' "$run_id" 2>/dev/null)" != "true" ]; then fail "the container exited"; fi
  if health=$(call http://127.0.0.1:8000/health 2>/dev/null); then break; fi
  sleep 1
done
[ -n "$health" ] || fail "/health did not answer within 60 s"
echo "$health" | jq -e '.status == 200 and .body.ok == true and .body.ready == false and .body.model == null and (.body.message | test("models pull"))' > /dev/null \
  || fail "/health: $health"
pass "/health: ok, not ready, says how to pull the model"

for _ in $(seq 1 90); do
  state=$(docker inspect --format '{{.State.Health.Status}}' "$run_id")
  [ "$state" = "healthy" ] && break
  sleep 1
done
[ "$state" = "healthy" ] || fail "the HEALTHCHECK reports $state"
pass "HEALTHCHECK healthy"

denied=$(call http://127.0.0.1:8000/v1/entities POST)
echo "$denied" | jq -e '.status == 401 and .body.error.code == "unauthorized"' > /dev/null || fail "without a token: $denied"
pass "POST /v1/entities without the token: 401"

refused=$(call http://127.0.0.1:8000/v1/entities POST "$token")
echo "$refused" | jq -e '.status == 503 and .body.error.code == "not_ready"' > /dev/null || fail "with the token, no model: $refused"
pass "POST /v1/entities with the token and no model: 503 not_ready"

list=$(docker exec "$run_id" node dist/main.js models list)
echo "$list" | grep -q "licence: Apache-2.0" || fail "models list: $list"
echo "$list" | grep -q "status: not pulled" || fail "models list: $list"
pass "models list shows the pinned model and its licence"

if docker logs "$run_id" 2>&1 | grep -q "hello"; then fail "the log quotes request text"; fi
pass "the log does not quote request text"

size=$(docker image inspect "$image" --format '{{.Size}}')
echo "Image size: $((size / 1024 / 1024)) MiB"
