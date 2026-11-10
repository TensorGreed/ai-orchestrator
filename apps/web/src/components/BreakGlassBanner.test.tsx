import { render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import { BreakGlassBanner, breakGlassBannerText } from "./BreakGlassBanner";

const fetchAuthMe = vi.fn();

vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  fetchAuthMe: () => fetchAuthMe()
}));

afterEach(() => {
  fetchAuthMe.mockReset();
});

describe("BreakGlassBanner (13.2)", () => {
  it("shows the end time for a break-glass session", async () => {
    fetchAuthMe.mockResolvedValue({ user: { id: "u", email: "a@x", role: "admin" }, session: { breakGlass: true, expiresAt: "2026-11-09T11:00:00.000Z" } });
    render(<BreakGlassBanner />);
    const banner = await screen.findByRole("alert");
    expect(banner).toHaveTextContent(/^Break-glass session\. Every action is recorded\. It ends at /);
    expect(banner).toHaveClass("break-glass-banner");
  });

  it("shows nothing for an ordinary session, an older API or a failed check", async () => {
    for (const answer of [
      () => Promise.resolve({ user: { id: "u", email: "a@x", role: "admin" }, session: { breakGlass: false, expiresAt: "2026-11-09T11:00:00.000Z" } }),
      () => Promise.resolve({ user: { id: "u", email: "a@x", role: "admin" } }),
      () => Promise.reject(new Error("401"))
    ]) {
      fetchAuthMe.mockImplementationOnce(answer);
      const { unmount } = render(<BreakGlassBanner />);
      await waitFor(() => expect(fetchAuthMe).toHaveBeenCalled());
      expect(screen.queryByRole("alert")).toBeNull();
      unmount();
      fetchAuthMe.mockClear();
    }
  });

  it("formats the end time, and falls back for a bad date", () => {
    expect(breakGlassBannerText("2026-11-09T11:00:00.000Z", "en-GB")).toMatch(/It ends at \d{2}:\d{2}\.$/);
    expect(breakGlassBannerText("not a date")).toBe("Break-glass session. Every action is recorded. It ends within the hour.");
  });
});
