import { describe, expect, it } from "vitest";
import { hashGuardProfile, parseGuardProfile, type GuardProfileInput } from "@ai-orchestrator/guard-sdk";
import { builtInGuardProfile, resolveGuardNodeProfiles, type GuardRunResolution, type ResolvedGuardProfile } from "./guard-runtime";

/**
 * 12.6 — a gateway-triggered run's toolset and client profiles (`resolution.gateway`, also in the stack) apply after a
 * Guard node's or guard port's own profiles; the node's own choice is made as if they were not there.
 */

function resolved(id: string, document: Partial<GuardProfileInput> = {}): ResolvedGuardProfile {
  const profile = parseGuardProfile({ id, name: id, version: "1", channels: {}, ...document });
  return { profileId: id, version: 1, hash: hashGuardProfile(profile), name: profile.name, profile };
}

function deps(resolution: GuardRunResolution, profiles: ResolvedGuardProfile[] = []) {
  const builtIn = builtInGuardProfile();
  return { resolveRun: () => resolution, loadProfile: (id: string) => [builtIn, ...profiles].find((entry) => entry.profileId === id) };
}

const ids = (profiles: ResolvedGuardProfile[]) => profiles.map((entry) => entry.profileId);

describe("gateway profiles on Guard nodes and ports", () => {
  const gateway = resolved("gw-toolset");

  it("leave an effective node with no binding on the built-in profile, and add themselves after it", async () => {
    const plain = await resolveGuardNodeProfiles(deps({ source: "none", stack: [], chain: [] }), { profileId: "effective" }, []);
    expect(ids(plain.profiles)).toEqual(["default"]);
    const withGateway = await resolveGuardNodeProfiles(deps({ source: "none", stack: [gateway], chain: [], gateway: [gateway] }), { profileId: "effective" }, []);
    expect(ids(withGateway.profiles)).toEqual(["default", "gw-toolset"]);
  });

  it("follow the run's own profiles, the enforced one first, and a node's named profile", async () => {
    const enforced = resolved("org-floor");
    const own = resolved("team");
    const resolution: GuardRunResolution = { source: "enforced", enforced, stack: [enforced, own, gateway], chain: [], gateway: [gateway] };
    expect(ids((await resolveGuardNodeProfiles(deps(resolution), { profileId: "effective" }, [])).profiles)).toEqual(["org-floor", "team", "gw-toolset"]);
    expect(ids((await resolveGuardNodeProfiles(deps(resolution, [own]), { profileId: "team" }, [])).profiles)).toEqual(["org-floor", "team", "gw-toolset"]);
  });

  it("come before the deployment's destination rules on a guard port, once each", async () => {
    const deployment = resolved("destinations");
    const resolution: GuardRunResolution = { source: "none", stack: [gateway, deployment], chain: [], gateway: [gateway], deployment };
    const port = await resolveGuardNodeProfiles(deps(resolution, [gateway]), { profileId: "gw-toolset" }, [], { withDeployment: true });
    expect(ids(port.profiles)).toEqual(["gw-toolset", "destinations"]);
  });
});
