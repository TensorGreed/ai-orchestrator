import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../lib/api";
import { ApiCatalogDialog } from "./ApiCatalogDialog";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return {
    ...actual,
    createOpenApiSpec: vi.fn(),
    refreshOpenApiSpec: vi.fn(),
    deleteOpenApiSpec: vi.fn(),
    updateOpenApiSpec: vi.fn(),
    probeMcpServer: vi.fn()
  };
});

beforeEach(() => {
  vi.resetAllMocks();
});

const view = (overrides: Partial<api.OpenApiSpecView> = {}): api.OpenApiSpecView => ({
  id: "oas_1",
  projectId: "team",
  name: "Desk",
  sourceUrl: "https://desk.example.com/openapi.json",
  baseUrl: "https://desk.example.com",
  title: "Desk",
  version: "1",
  operationCount: 3,
  warnings: [],
  createdBy: null,
  createdAt: "",
  updatedAt: "",
  fetchedAt: "",
  ...overrides
});

describe("ApiCatalogDialog", () => {
  it("adds an API from a URL into the project and reloads the palette", async () => {
    vi.mocked(api.createOpenApiSpec).mockResolvedValue({ spec: view() });
    const onChanged = vi.fn();
    render(<ApiCatalogDialog projectId="team" sources={[]} canRefreshMcp={false} onChanged={onChanged} onClose={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("Spec URL"), "https://desk.example.com/openapi.json{Enter}");
    await waitFor(() => expect(api.createOpenApiSpec).toHaveBeenCalledWith({ projectId: "team", url: "https://desk.example.com/openapi.json" }));
    expect(onChanged).toHaveBeenCalled();
    expect(await screen.findByRole("status")).toHaveTextContent("Added Desk: 3 operations in the palette.");
  });

  it("shows the server's refusal", async () => {
    vi.mocked(api.createOpenApiSpec).mockRejectedValue(new Error("This is a Swagger 2.0 spec. Only OpenAPI 3.x specs are supported."));
    render(<ApiCatalogDialog projectId={null} sources={[]} canRefreshMcp={false} onChanged={vi.fn()} onClose={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("Spec URL"), "https://x.example.com/swagger.json");
    await userEvent.click(screen.getByRole("button", { name: "Add API" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Swagger 2.0");
  });

  it("asks for a base URL when the spec names no server", async () => {
    vi.mocked(api.createOpenApiSpec).mockResolvedValue({ spec: view({ baseUrl: "" }) });
    vi.mocked(api.updateOpenApiSpec).mockResolvedValue({ spec: view() });
    const sources = [{ kind: "openapi_spec" as const, id: "oas_1", name: "Desk", itemCount: 3, refreshedAt: null, sourceUrl: "https://desk.example.com/openapi.json" }];
    const { rerender } = render(<ApiCatalogDialog projectId="team" sources={[]} canRefreshMcp={false} onChanged={vi.fn()} onClose={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("Spec URL"), "https://desk.example.com/openapi.json{Enter}");
    await waitFor(() => expect(api.createOpenApiSpec).toHaveBeenCalled());
    rerender(<ApiCatalogDialog projectId="team" sources={sources} canRefreshMcp={false} onChanged={vi.fn()} onClose={vi.fn()} />);
    await userEvent.type(await screen.findByLabelText("The spec names no server. Base URL"), "https://desk.example.com/v1");
    await userEvent.click(screen.getByRole("button", { name: "Save base URL" }));
    await waitFor(() => expect(api.updateOpenApiSpec).toHaveBeenCalledWith("oas_1", { baseUrl: "https://desk.example.com/v1" }));
  });

  it("refreshes and removes APIs, and refreshes MCP tools only for admins", async () => {
    vi.mocked(api.refreshOpenApiSpec).mockResolvedValue({ spec: view({ operationCount: 2 }), added: [], removed: ["getTicket"] });
    vi.mocked(api.deleteOpenApiSpec).mockResolvedValue({ ok: true });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const sources = [
      { kind: "openapi_spec" as const, id: "oas_1", name: "Desk", itemCount: 3, refreshedAt: null, sourceUrl: "https://desk.example.com/openapi.json" },
      { kind: "mcp_server" as const, id: "mcp_1", name: "Demo tools", itemCount: 4, refreshedAt: null }
    ];
    const { rerender } = render(<ApiCatalogDialog projectId="team" sources={sources} canRefreshMcp={false} onChanged={vi.fn()} onClose={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "Refresh tools of Demo tools" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Refresh Desk" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Desk refreshed: 2 operations; removed: getTicket.");
    await userEvent.click(screen.getByRole("button", { name: "Remove Desk" }));
    await waitFor(() => expect(api.deleteOpenApiSpec).toHaveBeenCalledWith("oas_1"));
    rerender(<ApiCatalogDialog projectId="team" sources={sources} canRefreshMcp onChanged={vi.fn()} onClose={vi.fn()} />);
    vi.mocked(api.probeMcpServer).mockResolvedValue({} as never);
    await userEvent.click(screen.getByRole("button", { name: "Refresh tools of Demo tools" }));
    await waitFor(() => expect(api.probeMcpServer).toHaveBeenCalledWith("mcp_1"));
  });
});
