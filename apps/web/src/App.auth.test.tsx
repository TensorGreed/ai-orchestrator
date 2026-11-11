import { render, screen } from "@testing-library/react";
import { vi } from "vitest";
import App from "./App";
import { ApiError } from "./lib/api";

const fetchAuthMeMock = vi.fn();

vi.mock("./lib/api", async () => {
  const actual = await vi.importActual<typeof import("./lib/api")>("./lib/api");
  return {
    ...actual,
    fetchAuthMe: (...args: unknown[]) => fetchAuthMeMock(...args)
  };
});

describe("App authentication gate", () => {
  beforeEach(() => {
    fetchAuthMeMock.mockReset();
  });

  it("renders login form when no active session exists", async () => {
    fetchAuthMeMock.mockRejectedValue(new ApiError("Unauthorized", 401, { error: "Unauthorized" }));

    render(<App />);

    expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toBeInTheDocument();
  });

  it.each([
    ["idle", "You were signed out after a period of inactivity."],
    ["expired", "Your session reached its maximum length. Sign in again."],
    ["evicted", "You were signed out because you signed in on another device or browser."],
    ["admin", "An administrator ended your session."]
  ])("shows why the session ended when a 401 carries reason %s", async (reason, message) => {
    const actual = await vi.importActual<typeof import("./lib/api")>("./lib/api");
    const fetchMock = vi.fn(async (url: string) =>
      url.endsWith("/api/auth/me")
        ? new Response(JSON.stringify({ error: "Session expired or invalid", reason }), { status: 401 })
        : new Response(JSON.stringify({ error: "Not found" }), { status: 404 })
    );
    vi.stubGlobal("fetch", fetchMock);
    fetchAuthMeMock.mockImplementation(() => actual.fetchAuthMe());
    try {
      render(<App />);
      expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
      expect(await screen.findByText(message)).toBeInTheDocument();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
