#!/usr/bin/env bash
# Merges single-platform images into one multi-arch OCI index and pushes that index by digest, without a tag.
# (`docker buildx imagetools create` only pushes to a tag; the release workflow adds tags after signing.)
# Prints <repository>@<index digest>.
#
# Usage: push-index.sh <repository> <image>@sha256:<digest>...
#   e.g. push-index.sh ghcr.io/tensorgreed/ai-orchestrator ghcr.io/tensorgreed/ai-orchestrator@sha256:... ...
# Environment:
#   INDEX_ANNOTATIONS  optional, one key=value per line, set as annotations on the index
#   REGISTRY_USERNAME / REGISTRY_PASSWORD  credentials for ghcr.io (anonymous for other registries)
# Needs: docker buildx, curl, jq, sha256sum.
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "usage: $0 <repository> <image>@sha256:<digest>..." >&2
  exit 64
fi
repo=$1
shift

args=(--dry-run)
while IFS= read -r annotation; do
  if [ -n "$annotation" ]; then args+=(--annotation "index:$annotation"); fi
done <<< "${INDEX_ANNOTATIONS:-}"

index=$(mktemp)
trap 'rm -f "$index"' EXIT
docker buildx imagetools create "${args[@]}" "$@" > "$index"
media_type=$(jq -er '.mediaType' "$index")
digest="sha256:$(sha256sum < "$index" | cut -d' ' -f1)"

host=${repo%%/*}
path=${repo#*/}
scheme=https
case "$host" in
  localhost:* | 127.0.0.1:*) scheme=http ;;
esac

auth=()
if [ "$host" = "ghcr.io" ]; then
  token=$(curl -fsS -u "${REGISTRY_USERNAME:?}:${REGISTRY_PASSWORD:?}" \
    "https://ghcr.io/token?service=ghcr.io&scope=repository:$path:pull,push" | jq -er '.token')
  auth=(-H "Authorization: Bearer $token")
fi

curl -fsS -X PUT "${auth[@]}" \
  -H "Content-Type: $media_type" \
  --data-binary "@$index" \
  "$scheme://$host/v2/$path/manifests/$digest" > /dev/null

echo "$repo@$digest"
