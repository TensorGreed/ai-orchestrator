#!/usr/bin/env bash
# Chaos run against a running scale stack (start it with `ops/loadtest/run.sh up`).
#
# While W2 (agents through the queue) and W1 (webhooks on the API replicas) run, it:
#   1. kills a worker that does not lead with SIGKILL, and starts it again 10 s later;
#   2. restarts an API replica (SIGTERM, drain, start);
#   3. pauses the leading worker for 60 s (frozen, connections open), then resumes it.
# Then it waits for the queue to settle and checks that no accepted run was lost (by run number), left unfinished, or ran twice (history, queue and the mock call counters). Runs the worker-loss
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

PAUSED="" W2_ID="" W2_OUT="" W1_ID="" W1_OUT=""
# shellcheck disable=SC2317 # called by the EXIT trap
cleanup() {
  if [[ -n "$PAUSED" ]]; then docker unpause "$PAUSED" >/dev/null 2>&1 || true; fi
  stop_samplers "$W2_OUT"
  stop_samplers "$W1_OUT"
  if [[ -n "$W2_ID" ]]; then stop_load "$W2_ID"; fi
  if [[ -n "$W1_ID" ]]; then stop_load "$W1_ID"; fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

start_load w2 "$W2_RATE" "${DURATION_S}s"
W2_ID=$LOAD_RUN_ID W2_OUT=$LOAD_OUT W2_PID=$LOAD_PID
start_load w1 "$W1_RATE" "${DURATION_S}s"
W1_ID=$LOAD_RUN_ID W1_OUT=$LOAD_OUT W1_PID=$LOAD_PID

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
at $((75 + PAUSE_S / 2))
event "leader while $leader is paused: $(leader_container)"
at $((75 + PAUSE_S))
docker unpause "$leader" >/dev/null
PAUSED=""
event "unpaused $leader; leader now: $(leader_container)"

finish_load "$W2_ID" "$W2_OUT" "$W2_PID"
finish_load "$W1_ID" "$W1_OUT" "$W1_PID"

# Recovery: how long after each fault its jobs were taken back (a job with a lost attempt is claimed again, or
# dead-lettered when a node had completed). Attributed to the last fault before that moment.
{
  echo "== chaos events"
  cat "$EVENTS"
  echo "jobs taken back from a lost worker: fault|jobs|first ms after the fault|last ms after the fault|final statuses"
  psql_q "WITH q AS (SELECT *, CASE WHEN status = 'dead' THEN updated_at ELSE started_at END AS taken_back
                       FROM ($(queue_rows_sql "$W2_ID")) r WHERE lost_count > 0 OR status = 'dead'),
               f AS (SELECT 'sigkill' AS fault, '$KILL_AT'::timestamptz AS at, '$PAUSE_AT'::timestamptz AS until
                     UNION ALL SELECT 'pause', '$PAUSE_AT'::timestamptz, 'infinity'::timestamptz)
          SELECT f.fault, count(q.id), round(min(extract(epoch FROM (q.taken_back - f.at)) * 1000)),
                 round(max(extract(epoch FROM (q.taken_back - f.at)) * 1000)), string_agg(DISTINCT q.status, ',')
            FROM f JOIN q ON q.taken_back >= f.at AND q.taken_back < f.until
           GROUP BY f.fault ORDER BY f.fault" | sed 's/^/  /'
  echo "dead-lettered runs: $(sed -n 's/^dead_lettered=//p' "$W2_OUT/reconcile.env") of $(sed -n 's/^accepted=//p' "$W2_OUT/reconcile.env") accepted; they are recorded as interrupted, not lost, and wait for a retry (the worker-loss policy decides whether they are re-run)"
  echo "dead-lettered jobs and why:"
  psql_q "SELECT coalesce(last_error, '?'), count(*) FROM ($(queue_rows_sql "$W2_ID")) q WHERE status = 'dead' GROUP BY 1" | sed 's/^/  /'
} | tee "$W2_OUT/chaos-report.txt"

# Errors other than "interrupted" are reported by the check but do not fail a chaos run; lost, unfinished and
# duplicated runs do.
failed=0
export MAX_FAILED=${MAX_FAILED:-none}
check_clean "$W2_OUT" || failed=1
check_clean "$W1_OUT" || failed=1
exit "$failed"
