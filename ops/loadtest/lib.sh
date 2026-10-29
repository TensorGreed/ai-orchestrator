# shellcheck shell=bash
# Shared functions for ops/loadtest/run.sh and ops/loadtest/chaos.sh. Source it; do not run it.
#
# Settings (environment, all optional):
#   WORKERS            workers to start (2)
#   RESULTS_DIR        where each load run writes its folder (ops/loadtest/results)
#   K6_IMAGE           k6 container image (grafana/k6:0.54.0)
#   SETTLE_TIMEOUT_S   how long to wait for queued runs to finish after the load stops (300)
#   SCALE_ADMIN_EMAIL / SCALE_ADMIN_PASSWORD   the bootstrap admin of the stack

LOADTEST_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$LOADTEST_DIR/../.." && pwd)
COMPOSE_FILE="$REPO_ROOT/docker-compose.scale.yml"
PROJECT=l2m-scale
NETWORK="${PROJECT}_default"
BALANCER_URL=${BALANCER_URL:-http://127.0.0.1:4229}
K6_IMAGE=${K6_IMAGE:-grafana/k6:0.54.0}
WORKERS=${WORKERS:-2}
RESULTS_DIR=${RESULTS_DIR:-$LOADTEST_DIR/results}
SETTLE_TIMEOUT_S=${SETTLE_TIMEOUT_S:-300}
ADMIN_EMAIL=${SCALE_ADMIN_EMAIL:-admin@example.com}
ADMIN_PASSWORD=${SCALE_ADMIN_PASSWORD:-scale-harness-password}
COOKIE_JAR="$RESULTS_DIR/.cookies"

dc() { docker compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"; }
log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*" >&2; }
die() { log "error: $*"; exit 1; }

require_tools() {
  local tool
  for tool in docker curl jq; do
    command -v "$tool" >/dev/null 2>&1 || die "$tool is required"
  done
}

# psql_q SQL: one query against the stack's Postgres; unaligned, tuples only, '|' between columns.
psql_q() { dc exec -T postgres psql -U l2m -d l2m_scale -v ON_ERROR_STOP=1 -AtX -c "$1"; }

# sql_literal VALUE: VALUE quoted as an SQL string literal.
sql_literal() { printf "'%s'" "${1//\'/\'\'}"; }

wait_ready() {
  local deadline=$((SECONDS + 180))
  until curl -fsS "$BALANCER_URL/ready" >/dev/null 2>&1; do
    ((SECONDS < deadline)) || die "the balancer at $BALANCER_URL/ready did not answer 200"
    sleep 1
  done
}

stack_up() {
  mkdir -p "$RESULTS_DIR"
  log "building the API image (l2m-scale-api:local)"
  dc build api
  dc up -d --wait postgres mock-llm mock-mcp
  # One replica first: it applies the migrations and creates the bootstrap admin before the others start.
  log "starting the first API replica"
  dc up -d --wait --scale api=1 api
  log "starting the second API replica and $WORKERS worker(s)"
  dc up -d --wait --scale api=2 --scale worker="$WORKERS" api worker
  dc up -d --wait nginx
  wait_ready
  log "stack ready on $BALANCER_URL"
}

stack_down() {
  dc down -v --remove-orphans
  if [[ "${REMOVE_IMAGE:-0}" == "1" ]]; then
    if docker image rm l2m-scale-api:local >/dev/null 2>&1; then log "removed image l2m-scale-api:local"; fi
  fi
}

login() {
  mkdir -p "$RESULTS_DIR"
  local body
  body=$(jq -nc --arg email "$ADMIN_EMAIL" --arg password "$ADMIN_PASSWORD" '{email: $email, password: $password}')
  curl -fsS -c "$COOKIE_JAR" -H 'content-type: application/json' -d "$body" "$BALANCER_URL/api/auth/login" >/dev/null \
    || die "login as $ADMIN_EMAIL failed"
}

api_get() { curl -fsS -b "$COOKIE_JAR" "$BALANCER_URL$1"; }

seed_workflows() {
  login
  local file id saved
  for file in "$LOADTEST_DIR"/workflows/*.json; do
    id=$(jq -r '.workflow.id' "$file")
    saved=$(jq -c '.workflow' "$file" \
      | curl -sS -b "$COOKIE_JAR" -H 'content-type: application/json' -d @- "$BALANCER_URL/api/workflows" | jq -r '.id // empty')
    [[ "$saved" == "$id" ]] || die "seeding $file failed"
    log "seeded $id"
  done
}

# Queue dispatch (EXECUTION_DISPATCH=queue) lets streamed manual runs execute on workers. The server reports it as
# `executionDispatch` in GET /api/cluster; a server without it (or with inline dispatch) prints nothing.
queue_dispatch_supported() {
  login
  [[ "$(api_get /api/cluster | jq -r '.executionDispatch // empty')" == "queue" ]]
}

mock_reset() {
  dc exec -T mock-llm wget -qO- --post-data= http://127.0.0.1:8080/stats/reset >/dev/null
  dc exec -T mock-mcp wget -qO- --post-data= http://127.0.0.1:8081/stats/reset >/dev/null
}

mock_stats() {
  printf '{"llm":%s,"mcp":%s}\n' \
    "$(dc exec -T mock-llm wget -qO- http://127.0.0.1:8080/stats)" \
    "$(dc exec -T mock-mcp wget -qO- http://127.0.0.1:8081/stats)"
}

# app_containers: the running API and worker containers, one name per line.
app_containers() {
  docker ps --filter "label=com.docker.compose.project=$PROJECT" --format '{{.Names}}' | grep -E -- '-(api|worker)-[0-9]+$' | sort
}

# leader_container: the container of the worker that leads (from the instance registry), or nothing.
leader_container() {
  local host
  host=$(psql_q "SELECT hostname FROM cluster_instances WHERE is_leader = 1 AND heartbeat_at > now() - interval '30 seconds' ORDER BY heartbeat_at DESC LIMIT 1")
  [[ -n "$host" ]] || return 0
  docker inspect -f '{{.Name}}' "$host" 2>/dev/null | sed 's#^/##'
}

# sample_postgres FILE: every 2 s, one CSV line of connection counts and lock waits, until killed.
sample_postgres() {
  local file=$1
  echo "time,connections,active,lock_waits,bus,leader_lock,idle_in_tx" >"$file"
  while true; do
    psql_q "SELECT to_char(clock_timestamp(), 'HH24:MI:SS'), count(*), count(*) FILTER (WHERE state = 'active'),
              count(*) FILTER (WHERE wait_event_type = 'Lock'), count(*) FILTER (WHERE application_name = 'l2m-bus'),
              count(*) FILTER (WHERE application_name = 'l2m-leader'), count(*) FILTER (WHERE state = 'idle in transaction')
            FROM pg_stat_activity WHERE datname = 'l2m_scale' AND pid <> pg_backend_pid()" 2>/dev/null | tr '|' ',' >>"$file" || true
    sleep 2
  done
}

# sample_containers FILE: every 10 s, CPU and memory of every container of the stack, until killed.
sample_containers() {
  local file=$1 ids
  echo "time,container,cpu,mem" >"$file"
  while true; do
    mapfile -t ids < <(docker ps -q --filter "label=com.docker.compose.project=$PROJECT")
    if ((${#ids[@]} > 0)); then
      docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}}' "${ids[@]}" 2>/dev/null \
        | sed "s#^#$(date +%H:%M:%S),#" >>"$file" || true
    fi
    sleep 10
  done
}

# The run number k6 put in a run's input (`"seq":12`), also inside JSON stored as a string (`\\"seq\\":12`).
SEQ_PATTERN='seq[\\"]*[[:space:]]*:[[:space:]]*[\\"]*([0-9]+)'

# run_rows_sql RUN_ID: the execution_history rows of one load run (the run tag is in the input or the custom data).
run_rows_sql() {
  local tag
  tag=$(sql_literal "%$1%")
  echo "SELECT id, status, error, duration_ms,
          substring(coalesce(input_json, '') || ' ' || coalesce(custom_data_json, '') FROM '$SEQ_PATTERN') AS seq
        FROM execution_history WHERE coalesce(input_json, '') || ' ' || coalesce(custom_data_json, '') LIKE $tag"
}

# queue_rows_sql RUN_ID: the execution_queue rows of one load run.
queue_rows_sql() {
  local tag
  tag=$(sql_literal "%$1%")
  echo "SELECT *, substring(payload_json FROM '$SEQ_PATTERN') AS seq FROM execution_queue WHERE payload_json LIKE $tag"
}

# settle RUN_ID: wait until no queued or running work of the run is left (or SETTLE_TIMEOUT_S passes).
settle() {
  local run_id=$1 deadline=$((SECONDS + SETTLE_TIMEOUT_S)) open
  while true; do
    open=$(psql_q "SELECT (SELECT count(*) FROM ($(queue_rows_sql "$run_id")) q WHERE q.status IN ('pending', 'running'))
                        + (SELECT count(*) FROM ($(run_rows_sql "$run_id")) h WHERE h.status = 'running')")
    [[ "$open" == "0" ]] && return 0
    if ((SECONDS >= deadline)); then
      log "settle: $open run(s) of $run_id still open after ${SETTLE_TIMEOUT_S}s"
      return 0
    fi
    sleep 2
  done
}

# start_load WORKLOAD RATE DURATION: starts k6 in the background. Sets LOAD_RUN_ID, LOAD_OUT and LOAD_PID for the
# caller (finish_load takes them).
start_load() {
  local workload=$1 rate=$2 duration=$3 streamed=0
  [[ -f "$LOADTEST_DIR/k6/$workload.js" ]] || die "unknown workload $workload (w1, w2, w3 or w4)"
  if [[ "$workload" == "w4" ]]; then
    if queue_dispatch_supported; then streamed=1; else log "w4: the server does not dispatch runs through the queue; streamed runs skipped"; fi
  fi
  LOAD_RUN_ID="$workload-$(date +%Y%m%d-%H%M%S)-$RANDOM"
  LOAD_OUT="$RESULTS_DIR/$LOAD_RUN_ID"
  mkdir -p "$LOAD_OUT"
  printf 'workload=%s\nrate=%s\nduration=%s\nworkers=%s\nstreamed=%s\n' "$workload" "$rate" "$duration" \
    "$(app_containers | grep -c -- '-worker-' || true)" "$streamed" >"$LOAD_OUT/params.txt"
  psql_q "SELECT now(), pg_current_wal_lsn()" | tr '|' '\n' >"$LOAD_OUT/.start"
  log "load $LOAD_RUN_ID: $rate run(s)/s for $duration"
  sample_postgres "$LOAD_OUT/pg-samples.csv" &
  echo $! >"$LOAD_OUT/.samplers"
  sample_containers "$LOAD_OUT/containers.csv" &
  echo $! >>"$LOAD_OUT/.samplers"
  docker run --rm --network "$NETWORK" --user "$(id -u):$(id -g)" \
    -v "$LOADTEST_DIR/k6:/scripts:ro" -v "$LOAD_OUT:/out" \
    -e BASE_URL=http://nginx -e LOAD_RUN_ID="$LOAD_RUN_ID" -e RATE="$rate" -e DURATION="$duration" \
    -e ADMIN_EMAIL="$ADMIN_EMAIL" -e ADMIN_PASSWORD="$ADMIN_PASSWORD" -e W4_STREAMED="$streamed" \
    "$K6_IMAGE" run --summary-export /out/k6-summary.json "/scripts/$workload.js" >"$LOAD_OUT/k6.txt" 2>&1 &
  # shellcheck disable=SC2034 # read by the scripts that source this file
  LOAD_PID=$!
}

# finish_load RUN_ID OUT PID: waits for k6, lets the queue drain, then collects and reconciles. Prints the report.
finish_load() {
  local run_id=$1 out=$2 pid=$3 k6_exit=0
  wait "$pid" || k6_exit=$?
  echo "$k6_exit" >"$out/k6.exit"
  log "k6 finished ($k6_exit); waiting for $run_id to settle"
  settle "$run_id"
  stop_samplers "$out"
  collect "$run_id" "$out"
  reconcile "$run_id" "$out"
  report "$out"
}

stop_samplers() {
  local pid
  [[ -n "${1:-}" && -f "$1/.samplers" ]] || return 0
  while read -r pid; do kill "$pid" 2>/dev/null || true; done <"$1/.samplers"
  rm -f "$1/.samplers"
}

collect() {
  local run_id=$1 out=$2 container
  psql_q "SELECT now(), pg_current_wal_lsn()" | tr '|' '\n' >"$out/.end"
  for container in $(app_containers); do
    docker exec "$container" wget -qO- http://127.0.0.1:4000/metrics 2>/dev/null \
      | grep -E '^[a-z_]+_(queue_|worker_slots|cluster_|executions?_)' >"$out/metrics-$container.txt" || true
  done
  mock_stats >"$out/mocks.json" 2>/dev/null || true
  psql_q "SELECT status, count(*) FROM ($(queue_rows_sql "$run_id")) q GROUP BY status ORDER BY status" >"$out/queue-status.txt"
  psql_q "SELECT status, count(*) FROM ($(run_rows_sql "$run_id")) h GROUP BY status ORDER BY status" >"$out/run-status.txt"
}

# reconcile RUN_ID OUT: compares k6's accepted count with execution_history. Writes reconcile.env.
reconcile() {
  local run_id=$1 out=$2 accepted rows seqs dups queue_seqs queue_dups dead interrupted lost extra
  accepted=$(jq -r '.metrics.runs_accepted.count // 0' "$out/k6-summary.json" 2>/dev/null || echo 0)
  IFS='|' read -r rows seqs dups <<<"$(psql_q "SELECT count(*), count(DISTINCT seq), (SELECT count(*) FROM (SELECT seq FROM ($(run_rows_sql "$run_id")) d GROUP BY seq HAVING count(*) > 1) x) FROM ($(run_rows_sql "$run_id")) h")"
  IFS='|' read -r queue_seqs queue_dups dead <<<"$(psql_q "WITH q AS (SELECT status, seq FROM ($(queue_rows_sql "$run_id")) r)
      SELECT count(DISTINCT seq), (SELECT count(*) FROM (SELECT seq FROM q GROUP BY seq HAVING count(*) > 1) x), count(*) FILTER (WHERE status = 'dead') FROM q")"
  interrupted=$(psql_q "SELECT count(*) FROM ($(run_rows_sql "$run_id")) h WHERE h.error LIKE '%interrupted%'")
  lost=$((accepted > seqs ? accepted - seqs : 0))
  extra=$((seqs > accepted ? seqs - accepted : 0))
  {
    echo "accepted=$accepted"
    echo "history_rows=$rows"
    echo "history_runs=$seqs"
    echo "duplicates=$dups"
    echo "lost=$lost"
    echo "unacknowledged_but_recorded=$extra"
    echo "queue_runs=$queue_seqs"
    echo "queue_duplicates=$queue_dups"
    echo "dead_lettered=$dead"
    echo "interrupted=$interrupted"
  } >"$out/reconcile.env"
  psql_q "SELECT count(*), round(percentile_cont(0.5) WITHIN GROUP (ORDER BY w)), round(percentile_cont(0.95) WITHIN GROUP (ORDER BY w)), round(percentile_cont(0.99) WITHIN GROUP (ORDER BY w)), round(max(w))
          FROM (SELECT extract(epoch FROM (started_at - scheduled_at)) * 1000 AS w FROM ($(queue_rows_sql "$run_id")) q WHERE started_at IS NOT NULL) s" >"$out/queue-wait-ms.txt"
  psql_q "SELECT count(*), round(percentile_cont(0.5) WITHIN GROUP (ORDER BY e)), round(percentile_cont(0.95) WITHIN GROUP (ORDER BY e)), round(percentile_cont(0.99) WITHIN GROUP (ORDER BY e)), round(max(e))
          FROM (SELECT extract(epoch FROM (completed_at - created_at)) * 1000 AS e FROM ($(queue_rows_sql "$run_id")) q WHERE status = 'completed' AND completed_at IS NOT NULL) s" >"$out/queue-e2e-ms.txt"
  psql_q "SELECT count(*), round(percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms)), round(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)), round(percentile_cont(0.99) WITHIN GROUP (ORDER BY duration_ms))
          FROM ($(run_rows_sql "$run_id")) h WHERE duration_ms IS NOT NULL" >"$out/run-duration-ms.txt"
}

# report OUT: a plain-text summary of one load run (also written to OUT/report.txt).
report() {
  local out=$1 summary="$1/k6-summary.json" start_lsn end_lsn wal_mb
  start_lsn=$(sed -n 2p "$out/.start"); end_lsn=$(sed -n 2p "$out/.end")
  wal_mb=$(psql_q "SELECT round(pg_wal_lsn_diff('$end_lsn', '$start_lsn') / 1048576.0, 1)" 2>/dev/null || echo "?")
  {
    echo "== $(basename "$out")"
    sed 's/^/   /' "$out/params.txt"
    if [[ -f "$summary" ]]; then
      jq -r '"k6: iterations \(.metrics.iterations.count // 0), \((.metrics.iterations.rate // 0) * 100 | round / 100)/s; accepted \(.metrics.runs_accepted.count // 0), rejected \(.metrics.runs_rejected.count // 0), throttled (429) \(.metrics.runs_throttled.count // 0); dropped iterations \(.metrics.dropped_iterations.count // 0)",
             "k6: http_req_duration ms: med \(.metrics.http_req_duration.med // 0 | round), p95 \(.metrics.http_req_duration["p(95)"] // 0 | round), p99 \(.metrics.http_req_duration["p(99)"] // 0 | round), max \(.metrics.http_req_duration.max // 0 | round); failed rate \(.metrics.http_req_failed.value // 0)"' "$summary"
    else
      echo "k6: no summary (see k6.txt)"
    fi
    echo "k6 exit code: $(cat "$out/k6.exit" 2>/dev/null || echo '?')"
    tr '\n' ' ' <"$out/reconcile.env" | sed 's/^/reconcile: /'; echo
    IFS='|' read -r n p50 p95 p99 max <"$out/queue-wait-ms.txt"
    [[ "$n" != "0" ]] && echo "queue wait (due -> claimed) ms over $n jobs: p50 $p50, p95 $p95, p99 $p99, max $max"
    IFS='|' read -r n p50 p95 p99 max <"$out/queue-e2e-ms.txt"
    [[ "$n" != "0" ]] && echo "queue end to end (enqueued -> completed) ms over $n jobs: p50 $p50, p95 $p95, p99 $p99, max $max"
    IFS='|' read -r n p50 p95 p99 <"$out/run-duration-ms.txt"
    echo "run duration (execution_history) ms over $n runs: p50 $p50, p95 $p95, p99 $p99"
    echo "queue rows by status: $(tr '\n' ' ' <"$out/queue-status.txt")"
    echo "runs by status: $(tr '\n' ' ' <"$out/run-status.txt")"
    if [[ -f "$out/pg-samples.csv" ]]; then
      awk -F, 'NR > 1 { if ($2 > c) c = $2; if ($3 > a) a = $3; if ($4 > l) l = $4; n++ } END { printf "postgres: max connections %d, max active %d, max lock waits %d (%d samples)\n", c, a, l, n }' "$out/pg-samples.csv"
    fi
    echo "postgres: WAL written ${wal_mb} MB"
    if [[ -f "$out/containers.csv" ]]; then
      awk -F, 'NR > 1 { gsub("%", "", $3); if ($3 + 0 > m[$2]) m[$2] = $3 + 0 } END { for (k in m) printf "cpu max %s %.0f%%\n", k, m[k] }' "$out/containers.csv" | sort
    fi
    if [[ -f "$out/mocks.json" ]]; then
      jq -r '"mocks: model calls \(.llm.completions) (tool-call answers \(.llm.toolCallAnswers), final \(.llm.finalAnswers)), echo \(.llm.echo), MCP tool calls \(.mcp.toolCalls)"' "$out/mocks.json" 2>/dev/null || true
    fi
  } | tee "$out/report.txt"
}

# check_clean OUT: fails when the run lost or duplicated anything.
check_clean() {
  local out=$1 lost dups queue_dups
  lost=$(sed -n 's/^lost=//p' "$out/reconcile.env")
  dups=$(sed -n 's/^duplicates=//p' "$out/reconcile.env")
  queue_dups=$(sed -n 's/^queue_duplicates=//p' "$out/reconcile.env")
  if [[ "$lost" != "0" || "$dups" != "0" || "$queue_dups" != "0" ]]; then
    log "FAILED $(basename "$out"): lost=$lost duplicates=$dups queue_duplicates=$queue_dups"
    return 1
  fi
  log "clean $(basename "$out"): 0 lost, 0 duplicate"
}
