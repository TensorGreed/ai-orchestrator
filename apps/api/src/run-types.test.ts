import { describe, expect, it } from "vitest";
import { runStarterId } from "./run-types.js";
import type { SafeUser } from "./services/auth-service.js";

describe("runStarterId (v80)", () => {
  const pat = { id: "u-pat", email: "pat@example.com", role: "operator" } as SafeUser;

  it("is the signed-in user's id when the run is recorded as started by their email", () => {
    expect(runStarterId({ policyActor: pat, triggeredBy: "Pat@Example.com" })).toBe("u-pat");
  });

  it("is nobody for a trigger's name, a run without a signed-in user, or an approver resuming someone's run", () => {
    expect(runStarterId({ policyActor: pat, triggeredBy: "form-submitter" })).toBeNull();
    expect(runStarterId({ triggeredBy: "pat@example.com" })).toBeNull();
    expect(runStarterId({ policyActor: pat })).toBeNull();
    expect(runStarterId({ policyActor: pat, triggeredBy: "pat@example.com", triggeredByUserId: null })).toBeNull();
  });

  it("takes the id the route gives over the signed-in user", () => {
    expect(runStarterId({ policyActor: pat, triggeredBy: "pat@example.com", triggeredByUserId: "u-starter" })).toBe("u-starter");
    expect(runStarterId({ triggeredBy: "chat-client", triggeredByUserId: "u-chat" })).toBe("u-chat");
  });
});
