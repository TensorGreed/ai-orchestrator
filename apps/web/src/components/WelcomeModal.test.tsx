import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  WelcomeModal,
  isWelcomeDismissed,
  markWelcomeDismissed
} from "./WelcomeModal";

const noop = () => undefined;

afterEach(() => {
  window.localStorage.clear();
});

function renderModal(
  overrides: Partial<React.ComponentProps<typeof WelcomeModal>> = {}
) {
  const props = {
    open: true,
    docsUrl: "https://example.com/docs",
    onTryTemplate: noop,
    onBuildAgent: noop,
    onDismiss: noop,
    ...overrides
  };
  return render(<WelcomeModal {...props} />);
}

describe("WelcomeModal", () => {
  it("renders nothing when open is false", () => {
    const { container } = renderModal({ open: false });
    expect(container.firstChild).toBeNull();
  });

  it("renders the title and three CTAs when open", () => {
    renderModal();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByTestId("welcome-try-template")).toBeInTheDocument();
    expect(screen.getByTestId("welcome-build-agent")).toBeInTheDocument();
    expect(screen.getByTestId("welcome-open-docs")).toBeInTheDocument();
  });

  it("invokes onTryTemplate when the template CTA is clicked", async () => {
    const user = userEvent.setup();
    const onTryTemplate = vi.fn();
    renderModal({ onTryTemplate });
    await user.click(screen.getByTestId("welcome-try-template"));
    expect(onTryTemplate).toHaveBeenCalledTimes(1);
  });

  it("invokes onBuildAgent when the agent CTA is clicked", async () => {
    const user = userEvent.setup();
    const onBuildAgent = vi.fn();
    renderModal({ onBuildAgent });
    await user.click(screen.getByTestId("welcome-build-agent"));
    expect(onBuildAgent).toHaveBeenCalledTimes(1);
  });

  it("renders the docs CTA as an external link with the supplied URL", () => {
    renderModal({ docsUrl: "https://docs.l2m.example/start" });
    const link = screen.getByTestId("welcome-open-docs") as HTMLAnchorElement;
    expect(link.tagName).toBe("A");
    expect(link.href).toBe("https://docs.l2m.example/start");
    expect(link.target).toBe("_blank");
    expect(link.rel).toContain("noreferrer");
  });

  it("invokes onDismiss when the close button is clicked", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    renderModal({ onDismiss });
    await user.click(screen.getByLabelText("Dismiss welcome"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("invokes onDismiss when 'Skip for now' is clicked", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    renderModal({ onDismiss });
    await user.click(screen.getByRole("button", { name: /skip for now/i }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("invokes onDismiss when the backdrop is clicked", () => {
    const onDismiss = vi.fn();
    const { container } = renderModal({ onDismiss });
    const backdrop = container.firstElementChild as HTMLElement;
    fireEvent.click(backdrop, { target: backdrop, currentTarget: backdrop });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("does NOT dismiss when clicking inside the card", async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    renderModal({ onDismiss });
    await user.click(screen.getByRole("dialog"));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("invokes onDismiss when Escape is pressed", () => {
    const onDismiss = vi.fn();
    renderModal({ onDismiss });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("does not invoke onDismiss for non-Escape keys", () => {
    const onDismiss = vi.fn();
    renderModal({ onDismiss });
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onDismiss).not.toHaveBeenCalled();
  });
});

describe("isWelcomeDismissed / markWelcomeDismissed", () => {
  it("isWelcomeDismissed returns false on a fresh storage", () => {
    expect(isWelcomeDismissed()).toBe(false);
  });

  it("markWelcomeDismissed flips the flag for subsequent isWelcomeDismissed calls", () => {
    expect(isWelcomeDismissed()).toBe(false);
    markWelcomeDismissed();
    expect(isWelcomeDismissed()).toBe(true);
  });
});
