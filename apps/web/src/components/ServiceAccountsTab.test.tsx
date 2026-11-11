import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@ai-orchestrator/shared";
import * as api from "../lib/api";
import { ServiceAccountsTab } from "./ServiceAccountsTab";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    fetchServiceAccounts: vi.fn(),
    createServiceAccount: vi.fn(),
    updateServiceAccount: vi.fn(),
    deleteServiceAccount: vi.fn(),
    fetchServiceAccountKeys: vi.fn(),
    createServiceAccountKey: vi.fn(),
    revokeServiceAccountKey: vi.fn(),
    rotateServiceAccountKey: vi.fn(),
    addProjectMember: vi.fn(),
    removeProjectMember: vi.fn()
  };
});

const projects: Project[] = [
  { id: "default", name: "Default", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
  { id: "alpha", name: "Alpha", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }
];

const account: api.ServiceAccount = {
  id: "usr_svc",
  name: "deployer",
  email: "deployer@service.invalid",
  role: "admin",
  description: "CI",
  createdBy: "usr_admin",
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  projects: [{ projectId: "alpha", role: "editor", customRoleId: null }],
  activeKeys: 1
};

const key = (overrides: Partial<api.ApiKeyRecord>): api.ApiKeyRecord => ({
  id: "apk_1",
  userId: "usr_svc",
  name: "ci",
  keyPrefix: "ao_abc",
  scopes: [],
  lastUsedAt: null,
  expiresAt: null,
  revokedAt: null,
  createdAt: "2026-11-01T00:00:00.000Z",
  ...overrides
});

describe("Service accounts tab", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(api.fetchServiceAccounts).mockResolvedValue({ serviceAccounts: [account] });
    vi.mocked(api.fetchServiceAccountKeys).mockResolvedValue({
      keys: [key({ scopes: ["role:viewer", "project:alpha", "legacy"] }), key({ id: "apk_2", name: "old", revokedAt: "2026-11-02T00:00:00.000Z" })]
    });
    vi.mocked(api.createServiceAccount).mockResolvedValue({ serviceAccount: { ...account, id: "usr_new", name: "nightly" } });
    vi.mocked(api.createServiceAccountKey).mockResolvedValue({ key: "ao_new.secret", record: key({ id: "apk_3" }) });
  });

  afterEach(() => {
    cleanup();
  });

  it("lists accounts and creates one", async () => {
    const user = userEvent.setup();
    render(<ServiceAccountsTab projects={projects} />);
    const table = await screen.findByRole("table", { name: "Service accounts" });
    expect(within(table).getByText("deployer")).toBeInTheDocument();
    expect(within(table).getByText("Alpha (editor)")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Name"), "nightly");
    await user.selectOptions(screen.getByLabelText("Role"), "operator");
    await user.click(screen.getByRole("button", { name: "Create service account" }));
    expect(api.createServiceAccount).toHaveBeenCalledWith({ name: "nightly", role: "operator", description: null });
  });

  it("shows key scopes and creates a key limited to a project with a ceiling, shown once", async () => {
    const user = userEvent.setup();
    render(<ServiceAccountsTab projects={projects} />);
    await user.click(await screen.findByRole("button", { name: "Manage" }));
    const keys = await screen.findByRole("table", { name: "Keys of deployer" });
    expect(within(keys).getByText("up to viewer · projects: Alpha · legacy (not enforced): legacy")).toBeInTheDocument();
    expect(within(keys).getByText("revoked")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Key name"), "gha");
    await user.click(screen.getByRole("checkbox", { name: "Alpha" }));
    // Limited to a project: the admin ceiling is not offered.
    const ceiling = screen.getByLabelText("Role ceiling");
    expect(within(ceiling).queryByRole("option", { name: "admin" })).not.toBeInTheDocument();
    await user.selectOptions(ceiling, "operator");
    await user.click(screen.getByRole("button", { name: "Generate key" }));
    expect(api.createServiceAccountKey).toHaveBeenCalledWith("usr_svc", { name: "gha", role: "operator", projects: ["alpha"] });
    expect(await screen.findByText("ao_new.secret")).toBeInTheDocument();
  });

  it("rotates a key with the default 24-hour window and shows the new key once; a rotated key shows when it ends", async () => {
    const user = userEvent.setup();
    const ends = new Date(Date.now() + 24 * 3_600_000).toISOString();
    vi.mocked(api.fetchServiceAccountKeys).mockResolvedValue({
      keys: [key({}), key({ id: "apk_old", name: "old-ci", supersededBy: "apk_1", rotatedAt: "2026-11-09T00:00:00.000Z", expiresAt: ends })]
    });
    vi.mocked(api.rotateServiceAccountKey).mockResolvedValue({
      key: "ao_rot.secret",
      record: key({ id: "apk_9" }),
      previous: key({ supersededBy: "apk_9", expiresAt: ends })
    });
    render(<ServiceAccountsTab projects={projects} />);
    await user.click(await screen.findByRole("button", { name: "Manage" }));
    const keys = await screen.findByRole("table", { name: "Keys of deployer" });
    // The rotated key cannot be rotated again and says when it stops working.
    expect(within(keys).queryByRole("button", { name: "Rotate old-ci" })).not.toBeInTheDocument();
    expect(within(keys).getByText("rotated")).toBeInTheDocument();
    await user.click(within(keys).getByRole("button", { name: "Rotate ci" }));
    await user.click(within(keys).getByRole("button", { name: "Rotate now" }));
    expect(api.rotateServiceAccountKey).toHaveBeenCalledWith("usr_svc", "apk_1", 24);
    expect(await screen.findByText("ao_rot.secret")).toBeInTheDocument();
    expect(screen.getByText(/The old key keeps working until/)).toBeInTheDocument();
  });

  it("adds the account to a project through the project member route", async () => {
    const user = userEvent.setup();
    vi.mocked(api.addProjectMember).mockResolvedValue({ ok: true } as Awaited<ReturnType<typeof api.addProjectMember>>);
    render(<ServiceAccountsTab projects={projects} />);
    await user.click(await screen.findByRole("button", { name: "Manage" }));
    await user.selectOptions(screen.getByLabelText("Project"), "default");
    await user.selectOptions(screen.getByLabelText("Project role"), "viewer");
    await user.click(screen.getByRole("button", { name: "Add to project" }));
    expect(api.addProjectMember).toHaveBeenCalledWith("default", { userId: "usr_svc", role: "viewer" });
  });
});
