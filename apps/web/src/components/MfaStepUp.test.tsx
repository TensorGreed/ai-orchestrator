import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiKey } from "../lib/api";
import { MfaGateCard } from "./MfaGateCard";
import { StepUpPrompt } from "./StepUpPrompt";
import { UsersAdminTab } from "./UsersAdminTab";

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** A fetch stub that answers by "METHOD path" from a queue per route. */
function routeFetch(routes: Record<string, Array<[number, unknown]>>) {
  const calls: Array<{ route: string; body?: string }> = [];
  const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
    const route = `${init?.method ?? "GET"} ${input}`;
    calls.push({ route, ...(typeof init?.body === "string" ? { body: init.body } : {}) });
    const queue = routes[route];
    const next = queue && queue.length > 1 ? queue.shift()! : queue?.[0];
    if (!next) return json(404, { error: `no stub for ${route}` });
    return json(next[0], next[1]);
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("StepUpPrompt", () => {
  it("asks for a code when an action needs step-up, verifies it, and the action goes through", async () => {
    const calls = routeFetch({
      "POST /api/auth/api-keys": [
        [403, { error: "Create an API key needs a recent MFA check.", code: "step_up_required", stepUp: { required: true, method: "totp", enrolled: true, maxAgeMinutes: 15 } }],
        [200, { key: "l2m_x", record: { id: "key_1" } }]
      ],
      "POST /api/auth/step-up": [
        [403, { error: "Invalid MFA code", code: "mfa_code_invalid" }],
        [200, { ok: true, mfaVerifiedAt: "2026-11-09T12:00:00.000Z", stepUpMaxAgeMinutes: 15 }]
      ]
    });
    render(<StepUpPrompt />);
    const created = createApiKey({ name: "ci" });

    expect(await screen.findByRole("dialog", { name: "Confirm it's you" })).toHaveTextContent(/next 15 minutes/);
    await userEvent.type(screen.getByLabelText("Verification code"), "000000");
    await userEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid MFA code");

    await userEvent.clear(screen.getByLabelText("Verification code"));
    await userEvent.type(screen.getByLabelText("Verification code"), "123456");
    await userEvent.click(screen.getByRole("button", { name: "Verify" }));
    await expect(created).resolves.toMatchObject({ key: "l2m_x" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(calls.map((call) => call.route)).toEqual([
      "POST /api/auth/api-keys",
      "POST /api/auth/step-up",
      "POST /api/auth/step-up",
      "POST /api/auth/api-keys"
    ]);
    expect(calls[2]!.body).toBe(JSON.stringify({ code: "123456" }));
  });

  it("Cancel leaves the action refused", async () => {
    routeFetch({
      "POST /api/auth/api-keys": [[403, { error: "Needs a recent MFA check.", code: "step_up_required", stepUp: { required: true, enrolled: true } }]]
    });
    render(<StepUpPrompt />);
    const created = createApiKey({ name: "ci" }).then(
      () => null,
      (error: unknown) => error
    );
    await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(await created).toMatchObject({ status: 403 });
  });
});

describe("MfaGateCard", () => {
  it("enroll: sets up the authenticator, shows the backup codes, and activates with a code", async () => {
    const calls = routeFetch({
      "POST /api/auth/mfa/enroll": [[200, { secret: "JBSWY3DPEHPK3PXP", otpauthUrl: "otpauth://totp/x", backupCodes: ["AAAA-BBBB"] }]],
      "POST /api/auth/mfa/activate": [[200, { enabled: true }]]
    });
    const onDone = vi.fn();
    render(<MfaGateCard gate="enroll" email="root@example.com" onDone={onDone} onSignOut={() => undefined} />);
    expect(screen.getByText(/Your role requires multi-factor authentication/)).toHaveTextContent("root@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Set up authenticator" }));
    expect(await screen.findByText("JBSWY3DPEHPK3PXP")).toBeInTheDocument();
    expect(screen.getByText("AAAA-BBBB")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Code from the app, to activate it"), "123456");
    await userEvent.click(screen.getByRole("button", { name: "Activate and continue" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(calls.at(-1)).toEqual({ route: "POST /api/auth/mfa/activate", body: JSON.stringify({ code: "123456" }) });
  });

  it("enroll, later than 10 minutes after signing in: asks for the password and sends it", async () => {
    const calls = routeFetch({
      "POST /api/auth/mfa/enroll": [
        [403, { code: "mfa_reauth_required", sso: false, error: "To set up MFA, enter your password again." }],
        [200, { secret: "JBSWY3DPEHPK3PXP", otpauthUrl: "otpauth://totp/x", backupCodes: ["AAAA-BBBB"] }]
      ]
    });
    render(<MfaGateCard gate="enroll" email="root@example.com" onDone={() => undefined} onSignOut={() => undefined} />);
    await userEvent.click(screen.getByRole("button", { name: "Set up authenticator" }));
    expect(await screen.findByText("To set up MFA, enter your password again.")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Your password"), "Pass-word-123!");
    await userEvent.click(screen.getByRole("button", { name: "Set up authenticator" }));
    expect(await screen.findByText("JBSWY3DPEHPK3PXP")).toBeInTheDocument();
    expect(calls.at(-1)).toEqual({ route: "POST /api/auth/mfa/enroll", body: JSON.stringify({ password: "Pass-word-123!" }) });
  });

  it("enroll from an old SSO session: tells the user to sign in again, no password field", async () => {
    routeFetch({
      "POST /api/auth/mfa/enroll": [[403, { code: "mfa_reauth_required", sso: true, error: "Sign in again through your identity provider." }]]
    });
    render(<MfaGateCard gate="enroll" email="sso@example.com" onDone={() => undefined} onSignOut={() => undefined} />);
    await userEvent.click(screen.getByRole("button", { name: "Set up authenticator" }));
    expect(await screen.findByText("Sign in again through your identity provider.")).toBeInTheDocument();
    expect(screen.queryByLabelText("Your password")).toBeNull();
    expect(screen.queryByRole("button", { name: "Set up authenticator" })).toBeNull();
  });

  it("verify: sends the code to step-up; Sign out is always there", async () => {
    const calls = routeFetch({ "POST /api/auth/step-up": [[200, { ok: true, mfaVerifiedAt: "x", stepUpMaxAgeMinutes: 0 }]] });
    const onDone = vi.fn();
    const onSignOut = vi.fn();
    render(<MfaGateCard gate="verify" email="root@example.com" onDone={onDone} onSignOut={onSignOut} />);
    await userEvent.type(screen.getByLabelText("Verification code"), "654321");
    await userEvent.click(screen.getByRole("button", { name: "Verify" }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(calls[0]).toEqual({ route: "POST /api/auth/step-up", body: JSON.stringify({ code: "654321" }) });
    await userEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(onSignOut).toHaveBeenCalled();
  });
});

describe("UsersAdminTab", () => {
  it("lists users and resets another user's MFA after confirmation; no button for yourself or pending invites", async () => {
    const calls = routeFetch({
      "GET /api/users": [
        [
          200,
          {
            users: [
              { id: "usr_me", email: "me@example.com", role: "admin", createdAt: "x" },
              { id: "usr_ada", email: "ada@example.com", role: "builder", createdAt: "x" },
              { id: "usr_inv", email: "new@example.com", role: "viewer", createdAt: "x", pending: true }
            ]
          }
        ]
      ],
      "POST /api/users/usr_ada/mfa/reset": [[200, { ok: true, userId: "usr_ada", hadMfa: true, sessionsEnded: 2 }]]
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<UsersAdminTab currentUserId="usr_me" />);
    expect(await screen.findByText("ada@example.com")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reset MFA for me@example.com" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reset MFA for new@example.com" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Reset MFA for ada@example.com" }));
    expect(await screen.findByText("ada@example.com: MFA reset; 2 sessions ended.")).toBeInTheDocument();
    expect(calls.map((call) => call.route)).toContain("POST /api/users/usr_ada/mfa/reset");
  });
});
