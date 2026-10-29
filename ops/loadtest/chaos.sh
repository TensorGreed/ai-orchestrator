#!/usr/bin/env bash
# Chaos run against a running scale stack (start it with `ops/loadtest/run.sh up`).
#
# While W2 (agents through the queue) and W1 (webhooks on the API replicas) run, it:
#   1. kills a worker that does not lead with SIGKILL, and starts it again 10 s later;
#   2. restarts an API replica (SIGTERM, drain, start);
#   3. pauses the leading worker for 60 s (frozen, connections open), then resumes it.
# Then it waits for the queue to settle and checks that no accepted run was lost or ran twice. Runs the worker-loss
# rules dead-lettered as "interrupted" are reported, not counted as lost: they are recorded and wait for a retry.
#
#   ops/loadtest/chaos.sh                 W2 at CHAOS_W2_RATE (3/s) and W1 at CHAOS_W1_RATE (5/s) for 150 s
#
# Settings: CHAOS_W2_RATE, CHAOS_W1_RATE, CHAOS_DURATION (seconds, at least 150), CHAOS_PAUSE_S (60), plus lib.sh's.
set -euo pipefail
# shellcheck source=lib.sh source-path=SCRIPTDIR
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

W2_RATE=${CHAOS_W2_RATE:-3}
W1_RATE=${CHAOS_W1_RATE:-5}
DURATION_S=${CHAOS_DURATION:-150}
PAUSE_S=${CHAOS_PAUSE_S:-60}
((DURATION_S >= 90 + PAUSE_S)) || die "CHAOS_DURATION must be at least $((90 + PAUSE_S)) s (the pause starts at 75 s)"

require_tools
wait_ready
mock_reset
mkdir -p "$RESULTS_DIR"

start_load w2 "$W2_RATE" "${DURATION_S}s"
W2_ID=$LOAD_RUN_ID W2_OUT=$LOAD_OUT W2_PID=$LOAD_PID
start_load w1 "$W1_RATE" "${DURATION_S}s"
W1_ID=$LOAD_RUN_ID W1_OUT=$LOAD_OUT W1_PID=$LOAD_PID
PAUSED=""
# shellcheck disable=SC2317 # called by the EXIT trap
cleanup() {
  if [[ -n "$PAUSED" ]]; then docker unpause "$PAUSED" >/dev/null 2>&1 || true; fi
  stop_samplers "$W2_OUT"
  stop_samplers "$W1_OUT"
}
trap cleanup EXIT

EVENTS="$W2_OUT/chaos-events.txt"
T0=$SECONDS
event() { printf '%s +%ss %s\n' "$(psql_q "SELECT to_char(now(), 'YYYY-MM-DD HH24:MI:SS.MS TZ')")" "$((SECONDS - T0))" "$*" | tee -a "$EVENTS" >&2; }
at() { local wait=$(($1 - (SECONDS - T0))); ((wait > 0)) && sleep "$wait"; return 0; }

at 20
leader=$(leader_container)
victim=$(app_containers | grep -- '-worker-' | grep -vx -- "${leader:-none}" | head -n 1)
[[ -n "$victim" ]] || die "no worker other than the leader to kill (start at least 2 workers)"
KILL_AT=$(psql_q "SELECT now()")
docker kill -s KILL "$victim" >/dev/null
event "SIGKILL $victim (leader: ${leader:-none})"
at 30
docker start "$victim" >/dev/null
event "started $victim again"

at 45
api=$(app_containers | grep -- '-api-' | head -n 1)
docker restart -t 30 "$api" >/dev/null
event "restarted $api"

at 75
leader=$(leader_container)
[[ -n "$leader" ]] || die "no leader found in cluster_instances"
PAUSE_AT=$(psql_q "SELECT now()")
docker pause "$leader" >/dev/null
PAUSED=$leader
event "paused leader $leader for ${PAUSE_S}s"
at $((75 + PAUSE_S))
docker unpause "$leader" >/dev/null
PAUSED=""
event "unpaused $leader; leader now: $(leader_container)"

failed=0
finish_load "$W2_ID" "$W2_OUT" "$W2_PID" || failed=1
finish_load "$W1_ID" "$W1_OUT" "$W1_PID" || failed=1

# Recovery: how long after each fault the reclaimed jobs ran again elsewhere (jobs with a lost attempt).
{
  echo "== chaos events"
  cat "$EVENTS"
  echo "jobs taken back from a lost worker, by the fault before their new claim (claim delay after the fault, ms):"
  psql_q "WITH q AS ($(queue_rows_sql "$W2_ID")),
               f AS (SELECT 'sigkill' AS fault, '$KILL_AT'::timestamptz AS at, '$PAUSE_AT'::timestamptz AS until
                     UNION ALL SELECT 'pause', '$PAUSE_AT'::timestamptz, 'infinity'::timestamptz)
          SELECT f.fault, count(q.id), round(min(extract(epoch FROM (q.started_at - f.at)) * 1000)),
                 round(max(extract(epoch FROM (q.started_at - f.at)) * 1000)), string_agg(DISTINCT q.status, ',')
            FROM f JOIN q ON q.lost_count > 0 AND q.started_at >= f.at AND q.started_at < f.until
           GROUP BY f.fault ORDER BY f.fault" | sed 's/^/  /'
  echo "dead-lettered jobs and why:"
  psql_q "SELECT coalesce(last_error, '?'), count(*) FROM ($(queue_rows_sql "$W2_ID")) q WHERE status = 'dead' GROUP BY 1" | sed 's/^/  /'
} | tee "$W2_OUT/chaos-report.txt"

check_clean "$W2_OUT" || failed=1
check_clean "$W1_OUT" || failed=1
exit "$failed"
