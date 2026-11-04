import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { vi } from "vitest";
import App from "./App";
import { ApiError } from "./lib/api";

const fetchAuthMeMock = vi.fn();
const lookupInviteMock = vi.fn();
const acceptInviteMock = vi.fn();

vi.mock("./lib/api", async () => {
  const actual = await vi.importActual<typeof import("./lib/api")>("./lib/api");
  return {
    ...actual,
    fetchAuthMe: (...args: unknown[]) => fetchAuthMeMock(...args),
    lookupInvite: (...args: unknown[]) => lookupInviteMock(...args),
    acceptInviteAndSignIn: (...args: unknown[]) => acceptInviteMock(...args)
  };
});

describe("App invite link (roadmap 7.3)", () => {
  beforeEach(() => {
    fetchAuthMeMock.mockReset().mockRejectedValue(new ApiError("Unauthorized", 401, { error: "Unauthorized" }));
    lookupInviteMock.mockReset();
    acceptInviteMock.mockReset();
    window.history.replaceState(null, "", "/?invite=tok_abcdefghijklmnop&workflow=w1");
  });

  afterEach(() => {
    window.history.replaceState(null, "", "/");
  });

  it("shows the accept form, drops the token from the address and sets the password", async () => {
    lookupInviteMock.mockResolvedValue({ email: "new@example.com", role: "builder", expiresAt: "2099-01-01T00:00:00.000Z" });
    acceptInviteMock.mockRejectedValue(new ApiError("This invite link is invalid or has expired", 404, {}));
    render(<App />);
    expect(await screen.findByText("new@example.com")).toBeInTheDocument();
    expect(window.location.search).toBe("?workflow=w1");
    expect(lookupInviteMock).toHaveBeenCalledWith("tok_abcdefghijklmnop");

    const submit = screen.getByRole("button", { name: "Set password and sign in" });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "short" } });
    expect(screen.getByText("Use at least 8 characters.")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "Chosen-Pass-1" } });
    fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "Chosen-Pass-2" } });
    expect(screen.getByText("The passwords do not match.")).toBeInTheDocument();
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Confirm password"), { target: { value: "Chosen-Pass-1" } });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await waitFor(() => expect(acceptInviteMock).toHaveBeenCalledWith("tok_abcdefghijklmnop", "Chosen-Pass-1"));
    expect(await screen.findByText("This invite link is invalid or has expired")).toBeInTheDocument();
  });

  it("explains a used or expired link and goes back to sign in", async () => {
    lookupInviteMock.mockRejectedValue(new ApiError("This invite link is invalid or has expired", 404, {}));
    render(<App />);
    expect(await screen.findByText("This invite link is invalid or has expired")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Go to sign in" }));
    expect(await screen.findByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });
});
