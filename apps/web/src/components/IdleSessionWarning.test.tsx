import { act, fireEvent, render, screen } from "@testing-library/react";
import { vi } from "vitest";
import { ApiError, type SessionInfo } from "../lib/api";
import { IdleSessionWarning } from "./IdleSessionWarning";

const fetchAuthMeMock = vi.fn();
const lastForegroundMock = vi.fn();
const inBackgroundSpy = vi.fn();

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    fetchAuthMe: (...args: unknown[]) => fetchAuthMeMock(...args),
    getLastForegroundRequestAt: () => lastForegroundMock(),
    inBackground: <T,>(run: () => Promise<T>) => {
      inBackgroundSpy();
      return actual.inBackground(run);
    }
  };
});

const T0 = Date.parse("2026-11-09T10:00:00.000Z");
const MINUTE = 60_000;

function session(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    handle: "ses_1",
    createdAt: new Date(T0).toISOString(),
    expiresAt: new Date(T0 + 12 * 60 * MINUTE).toISOString(),
    idleTimeoutMinutes: 10,
    idleExpiresAt: new Date(T0 + 10 * MINUTE).toISOString(),
    breakGlass: false,
    ...overrides
  };
}

async function advance(ms: number) {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
}

describe("IdleSessionWarning", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    fetchAuthMeMock.mockReset();
    inBackgroundSpy.mockReset();
    let lastForeground = T0;
    lastForegroundMock.mockReset().mockImplementation(() => lastForeground);
    fetchAuthMeMock.mockImplementation(async () => {
      lastForeground = Date.now();
      return {
        user: { id: "u1", email: "a@example.com", role: "admin" },
        session: session({ idleExpiresAt: new Date(Date.now() + 10 * MINUTE).toISOString() })
      };
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders nothing and runs no timer without an idle timeout", () => {
    const { container } = render(
      <IdleSessionWarning session={session({ idleTimeoutMinutes: null, idleExpiresAt: null })} onSessionRefreshed={vi.fn()} onSignedOut={vi.fn()} />
    );
    expect(container).toBeEmptyDOMElement();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("appears two minutes before the idle sign-out with a countdown", async () => {
    render(<IdleSessionWarning session={session()} onSessionRefreshed={vi.fn()} onSignedOut={vi.fn()} />);
    await advance(7 * MINUTE + 59_000);
    expect(screen.queryByText("You will be signed out soon")).not.toBeInTheDocument();
    await advance(2_000);
    expect(screen.getByText("You will be signed out soon")).toBeInTheDocument();
    expect(screen.getByText("1:59")).toBeInTheDocument();
  });

  it("Stay signed in sends a foreground /me and hides the warning", async () => {
    const onSessionRefreshed = vi.fn();
    render(<IdleSessionWarning session={session()} onSessionRefreshed={onSessionRefreshed} onSignedOut={vi.fn()} />);
    await advance(8 * MINUTE + 30_000);
    expect(screen.getByText("You will be signed out soon")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Stay signed in" }));
    });

    expect(fetchAuthMeMock).toHaveBeenCalledTimes(1);
    expect(inBackgroundSpy).not.toHaveBeenCalled();
    expect(onSessionRefreshed).toHaveBeenCalledWith(expect.objectContaining({ idleTimeoutMinutes: 10 }));
    expect(screen.queryByText("You will be signed out soon")).not.toBeInTheDocument();
  });

  it("at zero a background /me answering 401 signs out with reason idle", async () => {
    fetchAuthMeMock.mockRejectedValue(new ApiError("Session expired or invalid", 401, { error: "Session expired or invalid" }));
    const onSignedOut = vi.fn();
    render(<IdleSessionWarning session={session()} onSessionRefreshed={vi.fn()} onSignedOut={onSignedOut} />);
    await advance(10 * MINUTE + 1_000);
    expect(inBackgroundSpy).toHaveBeenCalled();
    expect(fetchAuthMeMock).toHaveBeenCalledTimes(1);
    expect(onSignedOut).toHaveBeenCalledWith("idle");
  });

  it("at zero a 200 means another tab was active: re-sync and hide", async () => {
    const onSessionRefreshed = vi.fn();
    // Another tab kept the session alive: the server's idle deadline moved, but this tab sent nothing.
    fetchAuthMeMock.mockImplementation(async () => ({
      user: { id: "u1", email: "a@example.com", role: "admin" },
      session: session({ idleExpiresAt: new Date(Date.now() + 9 * MINUTE).toISOString() })
    }));
    render(<IdleSessionWarning session={session()} onSessionRefreshed={onSessionRefreshed} onSignedOut={vi.fn()} />);
    await advance(10 * MINUTE + 1_000);
    expect(onSessionRefreshed).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("You will be signed out soon")).not.toBeInTheDocument();
  });

  it("trusts the server deadline: after activity in this tab it reads the deadline again before warning", async () => {
    render(<IdleSessionWarning session={session()} onSessionRefreshed={vi.fn()} onSignedOut={vi.fn()} />);
    await advance(5 * MINUTE);
    // A click in this tab: the deadline read at T0 is now out of date.
    lastForegroundMock.mockImplementation(() => T0 + 5 * MINUTE);
    await advance(3 * MINUTE + 1_000);
    expect(inBackgroundSpy).toHaveBeenCalledTimes(1);
    expect(fetchAuthMeMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("You will be signed out soon")).not.toBeInTheDocument();
    // The server's new deadline (T0 + 18 min 1 s) is the one the warning counts down to.
    await advance(8 * MINUTE);
    expect(screen.getByText("You will be signed out soon")).toBeInTheDocument();
    expect(screen.getByText("2:00")).toBeInTheDocument();
  });

  it("re-syncs from a later idleExpiresAt when /me is fetched elsewhere", async () => {
    const { rerender } = render(<IdleSessionWarning session={session()} onSessionRefreshed={vi.fn()} onSignedOut={vi.fn()} />);
    await advance(8 * MINUTE + 30_000);
    expect(screen.getByText("You will be signed out soon")).toBeInTheDocument();
    rerender(
      <IdleSessionWarning
        session={session({ idleExpiresAt: new Date(Date.now() + 10 * MINUTE).toISOString() })}
        onSessionRefreshed={vi.fn()}
        onSignedOut={vi.fn()}
      />
    );
    await advance(1_000);
    expect(screen.queryByText("You will be signed out soon")).not.toBeInTheDocument();
  });
});
