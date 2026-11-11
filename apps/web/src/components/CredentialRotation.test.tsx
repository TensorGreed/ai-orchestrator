import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@ai-orchestrator/shared";
import * as api from "../lib/api";
import { CredentialExpiry, RotateCredentialButton, rotatedNotice } from "./CredentialRotation";
import { ApiKeysTab } from "./SettingsPage";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, fetchApiKeys: vi.fn(), rotateApiKey: vi.fn(), revokeApiKey: vi.fn(), createApiKey: vi.fn() };
});

const NOW = Date.parse("2026-11-10T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const at = (ms: number) => new Date(NOW + ms).toISOString();

afterEach(() => {
  cleanup();
});

describe("CredentialExpiry", () => {
  it("says never, shows a badge within 7 days, and marks expired and rotated credentials", () => {
    const { rerender, container } = render(<CredentialExpiry expiresAt={null} now={NOW} />);
    expect(container.textContent).toBe("never");
    rerender(<CredentialExpiry expiresAt={at(30 * DAY)} now={NOW} />);
    expect(container.querySelector(".status-pill")).toBeNull();
    rerender(<CredentialExpiry expiresAt={at(7 * DAY)} now={NOW} />);
    expect(screen.getByText("expires in 7 days")).toBeInTheDocument();
    rerender(<CredentialExpiry expiresAt={at(DAY + HOUR)} now={NOW} />);
    expect(screen.getByText("expires in 1 day")).toBeInTheDocument();
    rerender(<CredentialExpiry expiresAt={at(2 * HOUR)} now={NOW} />);
    expect(screen.getByText("expires today")).toBeInTheDocument();
    rerender(<CredentialExpiry expiresAt={at(-HOUR)} now={NOW} />);
    expect(screen.getByText("expired")).toBeInTheDocument();
    rerender(<CredentialExpiry expiresAt={at(5 * HOUR)} rotated now={NOW} />);
    expect(screen.getByText("rotated")).toBeInTheDocument();
    expect(container.textContent).toContain("works until");
    rerender(<CredentialExpiry expiresAt={at(-HOUR)} rotated now={NOW} />);
    expect(screen.getByText("rotated, ended")).toBeInTheDocument();
  });

  it("rotatedNotice says how long the old secret works", () => {
    expect(rotatedNotice("key", null)).toBe("The old key has stopped working.");
    expect(rotatedNotice("token", new Date(Date.now() + HOUR).toISOString())).toMatch(/^The old token keeps working until /);
  });
});

describe("RotateCredentialButton", () => {
  it("asks for the grace window (24 hours by default) and can be cancelled", async () => {
    const user = userEvent.setup();
    const onRotate = vi.fn().mockResolvedValue(undefined);
    render(<RotateCredentialButton what="key" name="ci" onRotate={onRotate} />);
    await user.click(screen.getByRole("button", { name: "Rotate ci" }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onRotate).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Rotate ci" }));
    expect(screen.getByLabelText("Old key keeps working for")).toHaveValue("24");
    await user.selectOptions(screen.getByLabelText("Old key keeps working for"), "0");
    await user.click(screen.getByRole("button", { name: "Rotate now" }));
    expect(onRotate).toHaveBeenCalledWith(0);
    expect(await screen.findByRole("button", { name: "Rotate ci" })).toBeInTheDocument();
  });
});

describe("API keys tab", () => {
  const projects: Project[] = [{ id: "default", name: "Default", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" }];
  const key = (overrides: Partial<api.ApiKeyRecord>): api.ApiKeyRecord => ({
    id: "apk_1",
    userId: "usr_me",
    name: "ci",
    keyPrefix: "ao_abc",
    scopes: [],
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
    createdAt: "2026-11-01T00:00:00.000Z",
    supersededBy: null,
    rotatedAt: null,
    ...overrides
  });

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("rotates only your own active keys and shows the new key once with the old key's end", async () => {
    const user = userEvent.setup();
    const soon = new Date(Date.now() + 3 * DAY + HOUR).toISOString();
    vi.mocked(api.fetchApiKeys).mockResolvedValue({
      keys: [key({ expiresAt: soon }), key({ id: "apk_other", userId: "usr_someone", name: "theirs" }), key({ id: "apk_old", name: "old", supersededBy: "apk_1", expiresAt: soon })]
    });
    vi.mocked(api.rotateApiKey).mockResolvedValue({ key: "ao_new.secret", record: key({ id: "apk_2" }), previous: key({ supersededBy: "apk_2", expiresAt: soon }) });
    render(<ApiKeysTab isAdmin currentUserId="usr_me" ownerRole="admin" projects={projects} />);
    const table = await screen.findByRole("table");
    expect(within(table).getByText("expires in 3 days")).toBeInTheDocument();
    expect(within(table).queryByRole("button", { name: "Rotate theirs" })).not.toBeInTheDocument();
    expect(within(table).queryByRole("button", { name: "Rotate old" })).not.toBeInTheDocument();
    await user.click(within(table).getByRole("button", { name: "Rotate ci" }));
    await user.selectOptions(within(table).getByLabelText("Old key keeps working for"), "72");
    await user.click(within(table).getByRole("button", { name: "Rotate now" }));
    expect(api.rotateApiKey).toHaveBeenCalledWith("apk_1", 72);
    expect(await screen.findByText("ao_new.secret")).toBeInTheDocument();
    expect(screen.getByText(/The old key keeps working until/)).toBeInTheDocument();
  });
});
