import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";
import { AppSidebar, SIDEBAR_COLLAPSED_STORAGE_KEY } from "./AppSidebar";

describe("AppSidebar", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("renders every workspace item with the active one marked aria-current", () => {
    render(<AppSidebar activeMode="executions" canManageSecrets onModeChange={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Home" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Secrets" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Runs" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Home" })).not.toHaveAttribute("aria-current");
  });

  it("hides Secrets when the user cannot manage secrets", () => {
    render(<AppSidebar activeMode="dashboard" canManageSecrets={false} onModeChange={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Secrets" })).not.toBeInTheDocument();
  });

  it("switches mode on click", async () => {
    const user = userEvent.setup();
    const onModeChange = vi.fn();
    render(<AppSidebar activeMode="dashboard" canManageSecrets onModeChange={onModeChange} />);

    await user.click(screen.getByRole("button", { name: "Knowledge" }));
    expect(onModeChange).toHaveBeenCalledWith("knowledge");
  });

  it("persists the collapsed state in localStorage", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<AppSidebar activeMode="dashboard" canManageSecrets onModeChange={vi.fn()} />);

    const aside = screen.getByRole("complementary");
    expect(aside).toHaveAttribute("data-collapsed", "false");
    expect(localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe("0");

    await user.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(aside).toHaveAttribute("data-collapsed", "true");
    expect(localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe("1");

    unmount();
    render(<AppSidebar activeMode="dashboard" canManageSecrets onModeChange={vi.fn()} />);
    expect(screen.getByRole("complementary")).toHaveAttribute("data-collapsed", "true");
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeInTheDocument();
  });

  it("renders the project switcher when projects are provided", async () => {
    const user = userEvent.setup();
    const onCreateProject = vi.fn();
    render(
      <AppSidebar
        activeMode="dashboard"
        canManageSecrets
        onModeChange={vi.fn()}
        projects={[{ id: "p1", name: "Alpha", createdAt: "", updatedAt: "" }]}
        activeProjectId="p1"
        onChangeActiveProject={vi.fn()}
        onCreateProject={onCreateProject}
      />
    );

    expect(screen.getByRole("combobox", { name: "Project" })).toHaveValue("p1");
    await user.click(screen.getByRole("button", { name: "New project" }));
    expect(onCreateProject).toHaveBeenCalledTimes(1);
  });
});
