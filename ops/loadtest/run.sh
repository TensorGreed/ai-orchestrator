#!/usr/bin/env bash
# Scale harness driver for docker-compose.scale.yml (compose project l2m-scale, balancer on 127.0.0.1:4229).
#
#   ops/loadtest/run.sh up                       build, start 2 API replicas + $WORKERS workers, seed the workflows
#   ops/loadtest/run.sh load W [RATE] [DURATION] run one workload (w1..w4) at RATE runs/s for DURATION (k6 syntax)
#   ops/loadtest/run.sh smoke                    up, then W1 and W2 for 60 s at a modest rate
#   ops/loadtest/run.sh status                   containers, leader, queue depth
#   ops/loadtest/run.sh down                     stop and remove the stack and its volumes
#                                                (REMOVE_IMAGE=1 also removes the l2m-scale-api:local image)
#
# Each load run writes $RESULTS_DIR/<run id>/ (k6 output and summary, Postgres and container samples, metrics from
# every replica, reconcile.env, report.txt) and fails when a run accepted by the API was lost or ran twice.
# Needs docker (with compose), curl and jq. k6 runs in the grafana/k6 container.
set -euo pipefail
# shellcheck source=lib.sh source-path=SCRIPTDIR
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() { sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

load() {
  local workload=${1:?workload (w1, w2, w3 or w4)} rate=${2:-5} duration=${3:-60s}
  mkdir -p "$RESULTS_DIR"
  wait_ready
  mock_reset
  start_load "$workload" "$rate" "$duration"
  CURRENT_OUT=$LOAD_OUT
  trap 'stop_samplers "${CURRENT_OUT:-}"' EXIT
  finish_load "$LOAD_RUN_ID" "$LOAD_OUT" "$LOAD_PID"
  check_clean "$LOAD_OUT"
}

status() {
  dc ps --format 'table {{.Name}}\t{{.Status}}'
  echo "leader: $(leader_container)"
  psql_q "SELECT pool, status, count(*) FROM execution_queue GROUP BY pool, status ORDER BY pool, status" | sed 's/^/queue: /'
}

require_tools
case "${1:-}" in
  up) stack_up; seed_workflows ;;
  load) shift; load "$@" ;;
  smoke)
    stack_up
    seed_workflows
    load w1 "${SMOKE_W1_RATE:-10}" "${SMOKE_DURATION:-60s}"
    load w2 "${SMOKE_W2_RATE:-4}" "${SMOKE_DURATION:-60s}"
    ;;
  status) status ;;
  down) stack_down ;;
  -h | --help | help) usage 0 ;;
  *) usage 1 ;;
esac
