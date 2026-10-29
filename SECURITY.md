# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Use [GitHub's private vulnerability reporting](https://github.com/TensorGreed/ai-orchestrator/security/advisories/new) to report security issues confidentially. The maintainers will:

1. Acknowledge receipt within **72 hours**.
2. Triage the report, assess severity (CVSS), and confirm or dispute the finding within **7 days**.
3. Develop a fix in a private branch.
4. Coordinate a release and a public advisory once the fix lands. We aim for a **30-day** maximum from confirmed report to public advisory; severe issues may move faster.

If you don't receive an acknowledgement within 72 hours, please follow up — please don't disclose publicly while the report is in flight unless we've gone silent for an extended period.

## Scope

In scope:

- The L2M API server (`apps/api`) — Fastify routes, auth, RBAC, secret handling, webhook signature validation, leader election, MCP integration.
- The Studio web UI (`apps/web`) — XSS, CSRF, IDOR, leakage of sensitive fields.
- The agent runtime (`packages/agent-runtime`) — prompt-injection-driven privilege escalation, tool sandboxing.
- The MCP SDK (`packages/mcp-sdk`) — adapter behavior, especially the `stdio` transport which spawns child processes.
- The connector SDKs — credential handling, SSRF, request smuggling.
- The Helm chart and Docker images (`ops/helm/`, `apps/api/Dockerfile`, `apps/web/Dockerfile`).
- The VS Code extension (`apps/vscode-l2m-agent`) — workspace path-safety, command-execution gating.

Out of scope:

- Vulnerabilities in third-party dependencies (report to the upstream project; we'll backport fixes through dependency bumps).
- Findings that require local code execution on a developer's machine to exploit (e.g. malicious workflows imported from untrusted sources without warning).
- Denial-of-service via resource exhaustion when an admin has explicitly disabled rate limiting / body-size limits.
- Self-XSS that requires the victim to paste attacker-controlled content into their own DevTools.

## Verifying releases

Every `v*` release publishes `ghcr.io/tensorgreed/ai-orchestrator` (API) and `ghcr.io/tensorgreed/ai-orchestrator-web` (Studio UI) for `linux/amd64` and `linux/arm64`, built by [`.github/workflows/release-images.yml`](.github/workflows/release-images.yml). Nothing is signed with a long-lived key: signatures and attestations use short-lived Sigstore certificates issued to that workflow through GitHub Actions OIDC, and are recorded in the public Rekor transparency log. For each image:

- a **cosign signature** on the image digest the release tag points to;
- **SLSA build provenance** for that digest (repository, tag, commit, workflow run), stored by GitHub and in GHCR;
- a **CycloneDX SBOM** per platform image, attested on that platform's digest; BuildKit's SPDX SBOM and provenance are in the image index as well.

The GitHub Release carries the CycloneDX SBOMs of both images and of the source tree (`pnpm-lock.yaml`), the image digests and a `SHA256SUMS` file; each SBOM file has its own provenance attestation.

```bash
VERSION=v0.1.0
DIGEST=$(docker buildx imagetools inspect ghcr.io/tensorgreed/ai-orchestrator:$VERSION --format '{{json .Manifest.Digest}}' | tr -d '"')

cosign verify ghcr.io/tensorgreed/ai-orchestrator@$DIGEST \
  --certificate-identity "https://github.com/TensorGreed/ai-orchestrator/.github/workflows/release-images.yml@refs/tags/$VERSION" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com

gh attestation verify oci://ghcr.io/tensorgreed/ai-orchestrator@$DIGEST \
  --repo TensorGreed/ai-orchestrator \
  --signer-workflow TensorGreed/ai-orchestrator/.github/workflows/release-images.yml \
  --source-ref refs/tags/$VERSION
```

Any release tag matches `--certificate-identity-regexp '^https://github\.com/TensorGreed/ai-orchestrator/\.github/workflows/release-images\.yml@refs/tags/v.+$'` with the same issuer. The web image, the SBOMs, and pinning a verified digest in Helm or Docker Compose: [Verify a release](https://lsquarem.com/docs/operations/verify-a-release).

## Vulnerability policy

**What is scanned, and how often**

- **Every release:** each platform image of both images is scanned with [Grype](https://github.com/anchore/grype) before the release tags are added. Results go to the repository's code scanning. A **CRITICAL finding with a fixed version available stops the release**; other findings are reported, not blocking (the threshold is set in the release workflow).
- **Weekly:** the published `latest` images are scanned again ([`.github/workflows/image-scan.yml`](.github/workflows/image-scan.yml)) with the same gate, so advisories published after a release show up without waiting for the next one.
- **Dependencies:** Dependabot proposes grouped weekly updates for the pnpm workspace, the GitHub Actions the workflows use (pinned by commit SHA) and the Docker base images.

**Fix targets** for vulnerabilities in third-party packages shipped in the images (scan findings and Dependabot alerts), counted from the day one is confirmed to affect the latest release:

| Severity | Target |
| --- | --- |
| Critical | Fixed release within **7 days** |
| High | Fixed release within **30 days** |
| Medium | Fixed in a release within **90 days** |
| Low | With routine dependency updates |

A vulnerability reported in L2M's own code follows the reporting timeline above whatever its severity: acknowledgement within 72 hours, triage within 7 days, and a target of at most 30 days from a confirmed report to a fixed release and public advisory. When no upstream fix exists yet for a third-party package, the finding stays open in code scanning, we document a mitigation where one exists, and the target counts from the day the upstream fix is published.

## Supported versions

We maintain security fixes for the **latest released minor version** on `main`. Older versions are unsupported — backporting will be considered case-by-case for critical issues affecting deployed users.

## Recognition

We're a small project and don't run a paid bounty program, but security-relevant fixes are credited in the release notes and on the GitHub Security Advisory unless the reporter prefers anonymity.
