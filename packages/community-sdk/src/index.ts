/**
 * @ai-orchestrator/community-sdk
 *
 * Stable contract for `l2m-nodes-*` community packages. A community
 * package depends on this package as a peerDependency and default-
 * exports a `CommunityNodePackage` whose `register()` method receives
 * a `RegistrationApi`.
 *
 * See the docs at /docs/extensions/community-nodes for the authoring
 * guide and security model.
 */

export * from "./types";

export const COMMUNITY_PACKAGE_PREFIX = "l2m-nodes-";

/**
 * Current contract version. Bumping this is a breaking change for
 * community packages — set `apiVersion` on a package to match the
 * version it was authored against.
 */
export const CURRENT_API_VERSION = 1 as const;

/**
 * Returns true if the package's manifest declares the same API version
 * the running L2M instance supports. Communities packages targeting older
 * versions are skipped (with a warning) rather than crashing the load.
 */
export function isSupportedApiVersion(version: number): boolean {
  return version === CURRENT_API_VERSION;
}
