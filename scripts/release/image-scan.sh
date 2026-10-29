#!/usr/bin/env bash
# Scans every platform image of a multi-arch image with Grype and writes the full findings, unfiltered:
#   <out dir>/<asset prefix>-<os>-<arch>.grype.json   input for vuln-gate.mjs
#   <out dir>/<asset prefix>-<os>-<arch>.sarif        for GitHub code scanning
# The release gate is applied afterwards by vuln-gate.mjs, so the reports always list everything found.
#
# Usage: image-scan.sh <image>@sha256:<index digest> <asset prefix> <out dir>
# Needs: grype (or $GRYPE), docker buildx, jq.
set -euo pipefail

if [ "$#" -ne 3 ]; then
  echo "usage: $0 <image>@sha256:<index digest> <asset prefix> <out dir>" >&2
  exit 64
fi
ref=$1 prefix=$2 out=$3
grype=${GRYPE:-grype}
repo=${ref%@*}
here=$(cd "$(dirname "$0")" && pwd)

mkdir -p "$out"
platforms=$("$here/image-platforms.sh" "$ref")
if [ -z "$platforms" ]; then
  echo "no platform images found in $ref" >&2
  exit 1
fi

while read -r platform digest; do
  base="$out/$prefix-${platform//\//-}"
  echo "Scan $platform ($digest)"
  "$grype" "registry:$repo@$digest" \
    -o "json=$base.grype.json" \
    -o "sarif=$base.sarif" \
    -o table
done <<< "$platforms"
