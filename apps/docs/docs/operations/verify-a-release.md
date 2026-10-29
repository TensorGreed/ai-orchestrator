---
description: "Check an L2M release before you run it: keyless cosign signatures, GitHub build provenance, CycloneDX SBOMs and pinning image digests in Helm and Compose."
---

# Verify a release

Every `v*` release tag publishes two multi-arch images (`linux/amd64`, `linux/arm64`) to GHCR:

| Image | What it is |
| --- | --- |
| `ghcr.io/tensorgreed/ai-orchestrator` | The API (Fastify) |
| `ghcr.io/tensorgreed/ai-orchestrator-web` | The Studio web UI (Nginx) |

The release workflow ([`.github/workflows/release-images.yml`](https://github.com/TensorGreed/ai-orchestrator/blob/main/.github/workflows/release-images.yml)) builds them in GitHub Actions and, before the tags are added, signs and attests them with keyless Sigstore certificates issued for that workflow run (GitHub OIDC; no long-lived keys exist). This page shows how to check, without trusting the project's word:

- **which image** a tag points to (its digest),
- **that it was not swapped**: a cosign signature on that digest, made by this repository's release workflow on a release tag,
- **where it came from**: SLSA build provenance naming the repository, the tag, the commit and the workflow run,
- **what is inside**: a CycloneDX SBOM for every platform image, plus one for the pnpm workspace source.

Tools: [cosign](https://docs.sigstore.dev/cosign/system_config/installation/) 3.x (releases are signed with cosign 3.0.6), a current [GitHub CLI](https://cli.github.com/) (`gh`) and `jq`. `docker buildx` reads digests; `crane digest` works as well. `gh attestation verify` and `gh release download` need a GitHub login (`gh auth login`); cosign and docker need none for these public images.

## What each release contains

For each image, in the registry next to the image:

| Artifact | Attached to | Made by | Check with |
| --- | --- | --- | --- |
| Signature | Index digest (the digest a tag resolves to) | `cosign sign`, keyless | `cosign verify` |
| SLSA build provenance (v1) | Index digest; also stored by GitHub | `actions/attest` | `gh attestation verify` |
| CycloneDX SBOM (JSON) | Each platform digest | Syft, attested with `cosign attest --type cyclonedx` | `cosign verify-attestation` |
| BuildKit provenance (`mode=max`) and SPDX SBOM | Each platform image, inside the index | `docker buildx` | `docker buildx imagetools inspect` |

On the GitHub Release for the tag:

| Asset | Content |
| --- | --- |
| `l2m-api-<tag>-linux-amd64.cdx.json`, `l2m-api-<tag>-linux-arm64.cdx.json` | CycloneDX SBOMs of the API image, one per platform |
| `l2m-web-<tag>-linux-amd64.cdx.json`, `l2m-web-<tag>-linux-arm64.cdx.json` | CycloneDX SBOMs of the web image, one per platform |
| `l2m-source-<tag>.cdx.json` | CycloneDX SBOM of the source tree (`pnpm-lock.yaml` and the workspace packages) |
| `l2m-api-<tag>.platforms.txt`, `l2m-web-<tag>.platforms.txt` | Platform and platform digest of each image, one per line |
| `l2m-images-<tag>.txt` | `image:tag@index digest` of both images |
| `SHA256SUMS` | SHA-256 of every asset above |

Every `.cdx.json` file also has a build provenance attestation, so a downloaded SBOM can be checked on its own.

Set these once for the commands below:

```bash
VERSION=v0.1.0   # the release tag
REPO=TensorGreed/ai-orchestrator
API=ghcr.io/tensorgreed/ai-orchestrator
WEB=ghcr.io/tensorgreed/ai-orchestrator-web
ISSUER=https://token.actions.githubusercontent.com
IDENTITY="https://github.com/$REPO/.github/workflows/release-images.yml@refs/tags/$VERSION"
```

## 1. Resolve the digest

A tag can be moved; a digest cannot. Resolve the tag once and verify and deploy that digest:

```bash
API_DIGEST=$(docker buildx imagetools inspect "$API:$VERSION" --format '{{json .Manifest.Digest}}' | tr -d '"')
WEB_DIGEST=$(docker buildx imagetools inspect "$WEB:$VERSION" --format '{{json .Manifest.Digest}}' | tr -d '"')
echo "$API@$API_DIGEST"; echo "$WEB@$WEB_DIGEST"
```

The same digests are listed in the release asset `l2m-images-<tag>.txt` and in the release notes. They should match.

## 2. Check the signature

```bash
cosign verify "$API@$API_DIGEST" \
  --certificate-identity "$IDENTITY" \
  --certificate-oidc-issuer "$ISSUER"

cosign verify "$WEB@$WEB_DIGEST" \
  --certificate-identity "$IDENTITY" \
  --certificate-oidc-issuer "$ISSUER"
```

This passes only if the digest was signed by a Sigstore certificate issued to the release workflow of this repository running on that exact tag, and the signature is in the Rekor transparency log. To accept any release tag, for example in an admission policy, use a pattern instead of the exact identity:

```bash
cosign verify "$API@$API_DIGEST" \
  --certificate-identity-regexp '^https://github\.com/TensorGreed/ai-orchestrator/\.github/workflows/release-images\.yml@refs/tags/v.+$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

Staging runs of the same workflow on a branch publish `0.0.0-ci-<sha>` images signed with the branch's identity (`@refs/heads/...`), so they fail both checks above.

## 3. Check the build provenance

```bash
gh attestation verify "oci://$API@$API_DIGEST" --repo "$REPO" \
  --signer-workflow "$REPO/.github/workflows/release-images.yml" \
  --source-ref "refs/tags/$VERSION" \
  --deny-self-hosted-runners

gh attestation verify "oci://$WEB@$WEB_DIGEST" --repo "$REPO" \
  --signer-workflow "$REPO/.github/workflows/release-images.yml" \
  --source-ref "refs/tags/$VERSION" \
  --deny-self-hosted-runners
```

`gh` fetches the attestation from GitHub; add `--bundle-from-oci` to read the copy stored in GHCR instead. To see what the provenance states (repository, ref, commit, workflow and run):

```bash
gh attestation verify "oci://$API@$API_DIGEST" --repo "$REPO" --format json \
  --jq '.[].verificationResult.statement.predicate.buildDefinition'
```

BuildKit's own provenance (build arguments, base images, Dockerfile) is inside the image index, which the signature from step 2 covers:

```bash
docker buildx imagetools inspect "$API@$API_DIGEST" --format '{{ json (index .Provenance "linux/amd64").SLSA }}'
```

## 4. Get and inspect the SBOMs

From the GitHub Release:

```bash
mkdir "l2m-$VERSION" && cd "l2m-$VERSION"
gh release download "$VERSION" --repo "$REPO"
sha256sum -c SHA256SUMS

# Each SBOM file was attested by the release workflow:
for f in *.cdx.json; do
  gh attestation verify "$f" --repo "$REPO" --signer-workflow "$REPO/.github/workflows/release-images.yml"
done

# What is in the API image (amd64): component count, then name and version of each package
jq '.components | length' "l2m-api-$VERSION-linux-amd64.cdx.json"
jq -r '.components[] | "\(.name) \(.version)"' "l2m-api-$VERSION-linux-amd64.cdx.json" | sort | less
```

From the registry, verified against the platform digest it describes (the platform digests are in `l2m-api-<tag>.platforms.txt`, or listed by `docker buildx imagetools inspect "$API:$VERSION"`):

```bash
API_AMD64=$(awk '$1 == "linux/amd64" { print $2 }' "l2m-api-$VERSION.platforms.txt")
cosign verify-attestation --type cyclonedx "$API@$API_AMD64" \
  --certificate-identity "$IDENTITY" \
  --certificate-oidc-issuer "$ISSUER" \
  | jq -r '.payload' | head -n 1 | base64 -d | jq '.predicate' > api-amd64.cdx.json
```

BuildKit's SPDX SBOM of the same platform image:

```bash
docker buildx imagetools inspect "$API@$API_DIGEST" --format '{{ json (index .SBOM "linux/amd64").SPDX }}'
```

To check a release against today's vulnerability data, scan its SBOM, for example with [Grype](https://github.com/anchore/grype): `grype sbom:l2m-api-$VERSION-linux-amd64.cdx.json`.

## 5. Pin the digest you verified

Deploy the digest you checked, not just the tag.

**Helm.** The chart builds the image reference as `repository:tag`, so a tag with a digest suffix pins the digest:

```bash
helm upgrade --install ao ./ops/helm/ai-orchestrator \
  --set image.tag="$VERSION@$API_DIGEST" \
  --set web.image.tag="$VERSION@$WEB_DIGEST"
```

Check what the cluster is running: each container's `imageID` should end in the digest you verified.

```bash
kubectl get pods -l app.kubernetes.io/instance=ao \
  -o jsonpath='{range .items[*]}{range .status.containerStatuses[*]}{.image}{"  "}{.imageID}{"\n"}{end}{end}'
```

**Docker Compose.** `docker-compose.yml` and `docker-compose.prod.yml` build the images from source. To run the released images instead, add an override file that replaces each build with the digest-pinned image (`!reset` needs Docker Compose 2.24.4 or newer):

```yaml
# compose.release.yml
services:
  api:
    image: ghcr.io/tensorgreed/ai-orchestrator:v0.1.0@sha256:<api digest>
    build: !reset null
  web:
    image: ghcr.io/tensorgreed/ai-orchestrator-web:v0.1.0@sha256:<web digest>
    build: !reset null
```

```bash
docker compose -f docker-compose.yml -f compose.release.yml config --images   # shows the pinned references
docker compose -f docker-compose.yml -f compose.release.yml up -d
docker image inspect --format '{{join .RepoDigests "\n"}}' "$API:$VERSION"   # the digest that was pulled
```

## How releases are scanned

Each release scans every platform image with Grype before the tags are added. Findings go to the repository's code scanning; a CRITICAL finding that already has a fixed version stops the release. The published images are scanned again every week (`.github/workflows/image-scan.yml`), so new advisories against a shipped release surface without waiting for the next tag. Fix targets and how to report a problem: [`SECURITY.md`](https://github.com/TensorGreed/ai-orchestrator/blob/main/SECURITY.md).
