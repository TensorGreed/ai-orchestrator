#!/usr/bin/env bash
# Writes one CycloneDX JSON SBOM per platform of a released image, and the platform digests the SBOMs describe.
#
# Usage: image-sbom.sh <image>@sha256:<index digest> <asset prefix> <version> <out dir>
#   <out dir>/<asset prefix>-<os>-<arch>.cdx.json   one per platform
#   <out dir>/<asset prefix>.platforms.txt          "<platform> <platform digest>" per line
# Needs: syft (or $SYFT), docker buildx, jq.
set -euo pipefail

if [ "$#" -ne 4 ]; then
  echo "usage: $0 <image>@sha256:<index digest> <asset prefix> <version> <out dir>" >&2
  exit 64
fi
ref=$1 prefix=$2 version=$3 out=$4
syft=${SYFT:-syft}
repo=${ref%@*}
here=$(cd "$(dirname "$0")" && pwd)

mkdir -p "$out"
"$here/image-platforms.sh" "$ref" > "$out/$prefix.platforms.txt"
if [ ! -s "$out/$prefix.platforms.txt" ]; then
  echo "no platform images found in $ref" >&2
  exit 1
fi

while read -r platform digest; do
  file="$out/$prefix-${platform//\//-}.cdx.json"
  echo "SBOM $platform ($digest) -> $file"
  "$syft" scan "registry:$repo@$digest" \
    --source-name "$repo" --source-version "$version" \
    -o "cyclonedx-json=$file"
done < "$out/$prefix.platforms.txt"
