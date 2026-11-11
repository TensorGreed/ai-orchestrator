import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import { BreakGlassConfirmCard } from "./BreakGlassConfirmCard";

const confirmBreakGlass = vi.fn();

vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  confirmBreakGlass: (token: string) => confirmBreakGlass(token)
}));

afterEach(() => {
  confirmBreakGlass.mockReset();
});

describe("BreakGlassConfirmCard (13.2)", () => {
  it("names the admin and sends the token only on a click", async () => {
    const user = { id: "u", email: "root@example.com", role: "admin" };
    confirmBreakGlass.mockResolvedValue({ user, expiresAt: "2026-11-09T11:00:00.000Z" });
    const onSignedIn = vi.fn();
    render(<BreakGlassConfirmCard link={{ token: "bg_abc", email: "root@example.com" }} onSignedIn={onSignedIn} onDismiss={() => undefined} />);
    expect(screen.getByText("root@example.com")).toBeInTheDocument();
    expect(screen.getByText(/for one hour\. The session skips/)).toBeInTheDocument();
    expect(confirmBreakGlass).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Sign in for one hour" }));
    await waitFor(() => expect(onSignedIn).toHaveBeenCalledWith(user));
    expect(confirmBreakGlass).toHaveBeenCalledWith("bg_abc");
  });

  it("shows the server's refusal and can be cancelled", async () => {
    confirmBreakGlass.mockRejectedValue(new Error("This break-glass link is invalid, expired or already used."));
    const onDismiss = vi.fn();
    render(<BreakGlassConfirmCard link={{ token: "bg_abc", email: null }} onSignedIn={() => undefined} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in for one hour" }));
    expect(await screen.findByText(/already used/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onDismiss).toHaveBeenCalled();
  });
});
