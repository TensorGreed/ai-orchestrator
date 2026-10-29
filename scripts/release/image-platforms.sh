#!/usr/bin/env bash
# Lists the platform images of a multi-arch image index, one "<os>/<arch>[/<variant>] <digest>" line each.
# Buildx attestation manifests (platform unknown/unknown) are skipped.
#
# Usage: image-platforms.sh <image>@sha256:<index digest>
# Needs: docker buildx, jq.
set -euo pipefail

if [ "$#" -ne 1 ] || [[ "$1" != *@sha256:* ]]; then
  echo "usage: $0 <image>@sha256:<index digest>" >&2
  exit 64
fi

docker buildx imagetools inspect --raw "$1" | jq -r '
  .manifests[]
  | select(.platform.os != "unknown")
  | "\(.platform.os)/\(.platform.architecture)\(if .platform.variant then "/" + .platform.variant else "" end) \(.digest)"'
