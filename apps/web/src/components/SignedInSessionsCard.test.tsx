import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { vi } from "vitest";
import * as api from "../lib/api";
import type { SessionView } from "../lib/api";
import { SignedInSessionsCard } from "./SignedInSessionsCard";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    fetchMySessions: vi.fn(),
    revokeMySession: vi.fn(),
    revokeMyOtherSessions: vi.fn()
  };
});

const MAC_CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const WIN_FIREFOX = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0";

function view(overrides: Partial<SessionView>): SessionView {
  return {
    handle: "h",
    current: false,
    authMethod: "password",
    ipAddress: "10.0.0.1",
    userAgent: MAC_CHROME,
    createdAt: "2026-11-09T09:00:00.000Z",
    lastSeenAt: "2026-11-09T09:30:00.000Z",
    expiresAt: "2026-11-09T21:00:00.000Z",
    mfaVerified: false,
    breakGlass: false,
    ...overrides
  };
}

const POLICY = { idleTimeoutMinutes: 30, absoluteTimeoutHours: 12, maxPerUser: null };

describe("SignedInSessionsCard", () => {
  beforeEach(() => {
    vi.mocked(api.fetchMySessions).mockReset().mockResolvedValue({
      sessions: [
        view({ handle: "cur", current: true }),
        view({ handle: "other", userAgent: WIN_FIREFOX, ipAddress: "192.168.1.9", authMethod: "oidc", breakGlass: true })
      ],
      policy: POLICY
    });
    vi.mocked(api.revokeMyOtherSessions).mockReset().mockResolvedValue({ revoked: 1 });
    vi.mocked(api.revokeMySession).mockReset().mockResolvedValue({ ok: true, current: false });
  });

  it("lists sessions with device, IP, method, badges and the policy line", async () => {
    render(<SignedInSessionsCard />);
    expect(await screen.findByText("Chrome on macOS")).toBeInTheDocument();
    expect(screen.getByText("Firefox on Windows")).toBeInTheDocument();
    expect(screen.getByText("192.168.1.9")).toBeInTheDocument();
    expect(screen.getByText("SSO (OIDC)")).toBeInTheDocument();
    expect(screen.getByText("This device")).toBeInTheDocument();
    expect(screen.getByText("Break-glass")).toBeInTheDocument();
    expect(screen.getByText("Idle timeout: 30 minutes · Maximum session length: 12 hours · Session limit: not set")).toBeInTheDocument();

    const currentRow = screen.getByText("Chrome on macOS").closest("tr") as HTMLElement;
    expect(within(currentRow).queryByRole("button")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out Firefox on Windows" })).toBeInTheDocument();
  });

  it("Sign out other sessions calls the route and reports the count", async () => {
    render(<SignedInSessionsCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign out other sessions" }));
    await waitFor(() => expect(api.revokeMyOtherSessions).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("Signed out 1 other session.")).toBeInTheDocument();
    expect(api.fetchMySessions).toHaveBeenCalledTimes(2);
  });

  it("per-row Sign out ends that session by handle", async () => {
    render(<SignedInSessionsCard />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign out Firefox on Windows" }));
    await waitFor(() => expect(api.revokeMySession).toHaveBeenCalledWith("other"));
  });

  it("says not set when the policy has no idle timeout", async () => {
    vi.mocked(api.fetchMySessions).mockResolvedValue({
      sessions: [view({ handle: "cur", current: true })],
      policy: { idleTimeoutMinutes: null, absoluteTimeoutHours: 24, maxPerUser: 3 }
    });
    render(<SignedInSessionsCard />);
    expect(await screen.findByText("Idle timeout: not set · Maximum session length: 1 day · Session limit: 3 per user")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign out other sessions" })).toBeDisabled();
  });
});
