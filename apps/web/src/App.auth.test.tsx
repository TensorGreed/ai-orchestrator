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
});
