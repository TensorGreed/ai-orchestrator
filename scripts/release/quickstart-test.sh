#!/usr/bin/env bash
# Proves the two-command install: builds the API and web images from this tree, tags them the way
# docker-compose.quickstart.yml names them (ghcr.io/tensorgreed/l2m{,-web}:<test tag>), runs docs/install.sh against
# the compose file of this tree, and checks what a new user gets:
#
#   - the installer prints the address, the admin email and a generated password
#   - the studio answers on the chosen port; the API is reachable only through it (no API port published)
#   - the admin signs in through the studio's /api
#   - the MCP Agent Quickstart sample (echo model + mock MCP, no keys) imports and runs; a Starter template is used
#     and runs
#   - run progress streams through the studio's proxy without being buffered; a 2 MB request reaches the API
#   - the generated password is printed to the log once, the master key never; both files are mode 0600
#   - after a restart the key and the password are the same and sign-in still works
#   - running the installer again changes nothing and does not print the password
#
# Then `docker compose down -v` and the test tags are removed. Prints the time of each step.
#
# Usage: scripts/release/quickstart-test.sh   (from the repository root)
# Settings: QUICKSTART_PORT (default 4561), QUICKSTART_TAG (default v0.0.0-quickstart-test),
#           QUICKSTART_SKIP_BUILD=1 to use images already tagged, QUICKSTART_KEEP_IMAGES=1 to keep the tags.
# Needs: docker with compose v2, curl, jq.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
port=${QUICKSTART_PORT:-4561}
tag=${QUICKSTART_TAG:-v0.0.0-quickstart-test}
project="l2m-quickstart-test-$$"
work=$(mktemp -d)
studio="http://127.0.0.1:$port"
api_image="ghcr.io/tensorgreed/l2m:$tag"
web_image="ghcr.io/tensorgreed/l2m-web:$tag"
password_file=/app/apps/api/data/quickstart/initial-admin-password
key_file=/app/apps/api/data/quickstart/master-key
started=$(date +%s)
step_started=$started

export COMPOSE_PROJECT_NAME=$project
# Never reach a model server from the test (port 9 is the discard port; nothing answers).
export OLLAMA_BASE_URL=http://127.0.0.1:9

compose() { (cd "$work/l2m" && docker compose "$@"); }

cleanup() {
  if [ -f "$work/l2m/docker-compose.yml" ]; then
    compose down -v --remove-orphans > /dev/null 2>&1 || true
  fi
  if [ "${QUICKSTART_KEEP_IMAGES:-}" != 1 ] && [ "${QUICKSTART_SKIP_BUILD:-}" != 1 ]; then
    docker image rm "$api_image" "$web_image" > /dev/null 2>&1 || true
  fi
  rm -rf "$work"
}
trap cleanup EXIT

fail() {
  echo "FAIL: $*" >&2
  if [ -f "$work/l2m/docker-compose.yml" ]; then
    echo "--- api log (last 60 lines)" >&2
    compose logs --tail 60 api >&2 2>&1 || true
  fi
  exit 1
}
pass() { echo "ok   $*"; }
timing() {
  local now
  now=$(date +%s)
  echo "time $1: $((now - step_started)) s"
  step_started=$now
}

if [ "${QUICKSTART_SKIP_BUILD:-}" != 1 ]; then
  echo "== building $api_image"
  docker build --quiet -f "$repo/apps/api/Dockerfile" -t "$api_image" "$repo" > /dev/null
  timing "build the API image"
  echo "== building $web_image"
  docker build --quiet -f "$repo/apps/web/Dockerfile" -t "$web_image" "$repo" > /dev/null
  timing "build the web image"
fi

echo "== install (project $project, port $port)"
install_log="$work/install.log"
L2M_VERSION=$tag L2M_DIR="$work/l2m" L2M_PORT=$port L2M_PULL=missing \
  L2M_COMPOSE_URL="file://$repo/docker-compose.quickstart.yml" \
  sh "$repo/docs/install.sh" > "$install_log" 2>&1 || { cat "$install_log" >&2; fail "the installer failed"; }
timing "install to studio answering"
cat "$install_log"
grep -q "L2M is running: http://localhost:$port" "$install_log" || fail "the installer did not print the address"
email=$(sed -n 's/^  email: *//p' "$install_log")
password=$(sed -n 's/^  password: *//p' "$install_log")
[ "$email" = "admin@l2m.local" ] || fail "the installer printed email '$email'"
[ "${#password}" -ge 20 ] || fail "the installer printed no generated password"
pass "installer printed the address, $email and a generated password"

[ -z "$(docker port "$(compose ps -q api)")" ] || fail "the API port is published on the host"
pass "the API port is not published; the studio forwards to it"

jar="$work/jar"
login() {
  curl -sS -c "$jar" -H 'content-type: application/json' \
    -d "$(jq -n --arg e "$email" --arg p "$password" '{email: $e, password: $p}')" \
    "$studio/api/auth/login" | jq -r '.user.email // empty'
}
post() { curl -sS -b "$jar" -H 'content-type: application/json' --data "$2" "$studio$1"; }

[ "$(login)" = "$email" ] || fail "the admin could not sign in through the studio"
pass "signed in through $studio/api"
curl -fsS "$studio/" | grep -qi '<div id="root"' || fail "the studio page did not load"
pass "the studio page loads"

jq -n --rawfile s "$repo/samples/workflows/mcp-agent-quickstart-flow.json" '{json: $s}' > "$work/sample.json"
id=$(post /api/workflows/import "@$work/sample.json" | jq -r '.id // empty')
[ -n "$id" ] || fail "importing the MCP Agent Quickstart sample failed"
result=$(post "/api/workflows/$id/execute" '{"user_prompt":"What time is it and what is 2+2?"}')
[ "$(jq -r '.status' <<< "$result")" = success ] || fail "sample run: $(jq -c '{status, error}' <<< "$result")"
pass "MCP Agent Quickstart sample ran: $(jq -c '.output' <<< "$result" | cut -c1-120)"

templates=$(curl -sS -b "$jar" "$studio/api/templates?setup=none")
# CSV to JSON runs straight through (the approval starter, for one, waits for a person).
starter=$(jq -r '[(.templates // .items // [])[] | select(.category == "Starters" and (.id | test("csv-to-json")))][0].id // empty' <<< "$templates")
[ -n "$starter" ] || fail "no Starter template is listed: $(cut -c1-300 <<< "$templates")"
id=$(post "/api/templates/$starter/use" '{}' | jq -r '.workflowId // empty')
[ -n "$id" ] || fail "using the Starter template $starter failed"
result=$(post "/api/workflows/$id/execute" '{}')
[ "$(jq -r '.status' <<< "$result")" = success ] || fail "starter run ($starter): $(jq -c '{status, error}' <<< "$result")"
pass "Starter template $starter ran"
# Run progress streams through the studio's proxy as it happens: the first event of a run that waits 4 s must
# arrive well before the run ends (a buffering proxy would hold everything until the end).
jq -n '{workflow: {id: "wf-quickstart-stream", name: "Quickstart stream check", schemaVersion: "1.0.0", workflowVersion: 1,
  nodes: [{id: "trigger", type: "manual_trigger", name: "Trigger", position: {x: 0, y: 0}, config: {}},
          {id: "wait", type: "wait_node", name: "Wait", position: {x: 240, y: 0}, config: {resumeMode: "timer", delayMs: 4000}}],
  edges: [{id: "e1", source: "trigger", target: "wait"}]}}' > "$work/stream.json"
id=$(post /api/workflows/import "@$work/stream.json" | jq -r '.id // empty')
[ -n "$id" ] || fail "importing the stream check workflow failed"
stream_start=$(date +%s%N)
first_event=""
while IFS= read -r line; do
  if [ -z "$first_event" ] && [[ "$line" == event:* ]]; then first_event=$((($(date +%s%N) - stream_start) / 1000000)); fi
done < <(curl -sS -N -b "$jar" -H 'content-type: application/json' --data '{}' "$studio/api/workflows/$id/execute/stream")
stream_total=$((($(date +%s%N) - stream_start) / 1000000))
[ -n "$first_event" ] || fail "the run stream sent no events"
[ "$stream_total" -ge 3500 ] || fail "the stream check run ended after $stream_total ms; it should wait 4 s"
[ "$first_event" -lt 2000 ] || fail "the first stream event arrived after $first_event ms of $stream_total ms: the proxy buffers it"
pass "run progress streams through the studio: first event after $first_event ms, run ended after $stream_total ms"

# Uploads above nginx's 1 MB default reach the API (a 2 MB import is refused by the API, not by the proxy with 413).
head -c 2000000 /dev/zero | tr '\0' 'a' | jq -Rs '{json: .}' > "$work/big.json"
code=$(curl -sS -o /dev/null -w '%{http_code}' -b "$jar" -H 'content-type: application/json' --data "@$work/big.json" "$studio/api/workflows/import")
[ "$code" != 413 ] || fail "a 2 MB request was refused by the studio's proxy (413)"
pass "a 2 MB request reaches the API (HTTP $code)"
timing "sign in and run the workflows"

logs=$(compose logs api 2>&1)
key=$(compose exec -T api cat "$key_file")
[ "$(grep -c -F -- "$password" <<< "$logs")" = 1 ] || fail "the password is not in the log exactly once"
! grep -q -F -- "$key" <<< "$logs" || fail "the master key is in the log"
[ "$(compose exec -T api stat -c %a "$key_file" "$password_file" | sort -u)" = 600 ] || fail "the key or password file is not mode 0600"
pass "password logged once, master key never; both files 0600"

compose restart api > /dev/null 2>&1
for _ in $(seq 1 90); do
  if curl -fsS "$studio/health" > /dev/null 2>&1; then break; fi
  sleep 2
done
[ "$(compose exec -T api cat "$key_file")" = "$key" ] || fail "the master key changed on restart"
[ "$(compose logs api 2>&1 | grep -c -F -- "$password")" = 1 ] || fail "the password was printed again after a restart"
[ "$(login)" = "$email" ] || fail "sign-in failed after a restart"
pass "after a restart: same key, password not printed again, sign-in works"
timing "restart"

L2M_VERSION=$tag L2M_DIR="$work/l2m" L2M_PULL=missing L2M_COMPOSE_URL="file://$repo/docker-compose.quickstart.yml" \
  sh "$repo/docs/install.sh" > "$install_log" 2>&1 || { cat "$install_log" >&2; fail "running the installer again failed"; }
grep -q "L2M is running: http://localhost:$port" "$install_log" || fail "the second install did not keep the port"
! grep -q -F -- "$password" "$install_log" || fail "the second install printed the password"
[ "$(login)" = "$email" ] || fail "sign-in failed after the second install"
pass "installer is idempotent: same port, no password printed, sign-in works"
timing "second install"

compose down -v > /dev/null 2>&1
! docker volume inspect "${project}_l2m-data" > /dev/null 2>&1 || fail "down -v left the data volume"
pass "down -v removed the containers and the data volume"
echo "All quickstart checks passed in $(($(date +%s) - started)) s."
