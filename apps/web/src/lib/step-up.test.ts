import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, createApiKey, fetchAuthMe, fetchDeploymentUsers, mfaGateFromMe, setAuthChallengeHandlers, stepUpFromPayload } from "./api";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const STEP_UP = {
  error: "Create an API key needs a recent MFA check. Enter a code from your authenticator app.",
  code: "step_up_required",
  stepUp: { required: true, action: "api_key.create", method: "totp", enrolled: true, maxAgeMinutes: 15 }
};

afterEach(() => {
  setAuthChallengeHandlers({ onStepUp: undefined, onMfaGate: undefined });
  vi.unstubAllGlobals();
});

describe("13.2 step-up in the API client", () => {
  it("asks for a code on step_up_required and retries the request once after it passes", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(403, STEP_UP))
      .mockResolvedValueOnce(json(200, { key: "l2m_x", record: { id: "key_1" } }));
    vi.stubGlobal("fetch", fetchMock);
    const onStepUp = vi.fn(async () => true);
    setAuthChallengeHandlers({ onStepUp });

    const created = await createApiKey({ name: "ci" });
    expect(created.key).toBe("l2m_x");
    expect(onStepUp).toHaveBeenCalledWith({
      action: "api_key.create",
      method: "totp",
      enrolled: true,
      maxAgeMinutes: 15,
      message: STEP_UP.error
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]![1]).toMatchObject({ method: "POST", body: JSON.stringify({ name: "ci" }) });
  });

  it("gives up (one ApiError) when the user cancels, or when the retry asks again", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(403, STEP_UP)));
    setAuthChallengeHandlers({ onStepUp: async () => false });
    await expect(createApiKey({ name: "ci" })).rejects.toMatchObject({ status: 403, payload: { code: "step_up_required" } });

    const fetchMock = vi.fn().mockResolvedValue(json(403, STEP_UP));
    vi.stubGlobal("fetch", fetchMock);
    const onStepUp = vi.fn(async () => true);
    setAuthChallengeHandlers({ onStepUp });
    await expect(createApiKey({ name: "ci" })).rejects.toBeInstanceOf(ApiError);
    expect(onStepUp).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not prompt for an API key or a user without an authenticator", async () => {
    const onStepUp = vi.fn(async () => true);
    setAuthChallengeHandlers({ onStepUp });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(403, { ...STEP_UP, stepUp: { ...STEP_UP.stepUp, enrolled: false } })));
    await expect(createApiKey({ name: "ci" })).rejects.toBeInstanceOf(ApiError);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(403, { ...STEP_UP, stepUp: { required: true, credential: "api_key" } })));
    await expect(createApiKey({ name: "ci" })).rejects.toBeInstanceOf(ApiError);
    expect(onStepUp).not.toHaveBeenCalled();
    expect(stepUpFromPayload({ error: "x" })).toBeNull();
  });

  it("reports an MFA-restricted session to the app", async () => {
    const onMfaGate = vi.fn();
    setAuthChallengeHandlers({ onMfaGate });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(403, { error: "Set up MFA", code: "mfa_enrollment_required" })));
    await expect(fetchDeploymentUsers()).rejects.toBeInstanceOf(ApiError);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(403, { error: "Verify", code: "mfa_verification_required" })));
    await expect(fetchDeploymentUsers()).rejects.toBeInstanceOf(ApiError);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(403, { error: "Insufficient permissions" })));
    await expect(fetchDeploymentUsers()).rejects.toBeInstanceOf(ApiError);
    expect(onMfaGate.mock.calls).toEqual([["enroll"], ["verify"]]);
  });

  it("reads the gate from /api/auth/me", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(200, { user: { id: "u" }, mfaVerificationRequired: true })));
    expect(mfaGateFromMe(await fetchAuthMe())).toBe("verify");
    expect(mfaGateFromMe({ mfaEnrollmentRequired: true })).toBe("enroll");
    expect(mfaGateFromMe({})).toBeNull();
  });
});
