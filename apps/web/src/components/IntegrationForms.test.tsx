import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseOpenApiDocument } from "@ai-orchestrator/shared";
import * as api from "../lib/api";
import { clearOpenApiSpecCache, McpToolArgsForm, McpUseFormButton, OpenApiOperationForm } from "./IntegrationForms";

vi.mock("../lib/api", async () => {
  const actual = await vi.importActual<typeof import("../lib/api")>("../lib/api");
  return { ...actual, fetchOpenApiSpec: vi.fn() };
});

beforeEach(() => {
  vi.resetAllMocks();
  clearOpenApiSpecCache();
});

type Config = Record<string, unknown>;

function Harness({ initial, children }: { initial: Config; children: (config: Config, setConfig: React.Dispatch<React.SetStateAction<Config>>) => React.ReactNode }) {
  const [config, setConfig] = useState(initial);
  return (
    <>
      {children(config, setConfig)}
      <pre data-testid="config">{JSON.stringify(config)}</pre>
    </>
  );
}

const readConfig = () => JSON.parse(screen.getByTestId("config").textContent ?? "{}") as Config;

const calculatorSchema = {
  type: "object",
  properties: { expression: { type: "string", description: "Math to work out" }, precision: { type: "integer" } },
  required: ["expression"]
};

describe("McpToolArgsForm", () => {
  it("writes the arguments template from the form, keeping expressions", async () => {
    render(
      <Harness initial={{ toolName: "calculator", argsTemplate: "{}", argValues: {} }}>
        {(config, setConfig) => <McpToolArgsForm toolName="calculator" inputSchema={calculatorSchema} config={config} setConfig={setConfig} />}
      </Harness>
    );
    expect(screen.getByText("Required")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("expression"), "{{{{ webhook.sum }}");
    await userEvent.type(screen.getByLabelText("precision"), "{{{{ vars.digits }}");
    const config = readConfig();
    expect(config.argValues).toEqual({ expression: "{{ webhook.sum }}", precision: "{{ vars.digits }}" });
    expect(config.argsTemplate).toBe('{\n  "expression": "{{ webhook.sum }}",\n  "precision": {{ vars.digits }}\n}');
    expect(screen.queryByText("Required")).not.toBeInTheDocument();
  });

  it("switches to JSON, and back to the form only after a confirm when JSON was written", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(
      <Harness initial={{ toolName: "calculator", argsTemplate: '{"expression":"1+1"}', argValues: { expression: "1+1" } }}>
        {(config, setConfig) =>
          config.argValues ? (
            <McpToolArgsForm toolName="calculator" inputSchema={calculatorSchema} config={config} setConfig={setConfig} />
          ) : (
            <McpUseFormButton inputSchema={calculatorSchema} config={config} setConfig={setConfig} />
          )
        }
      </Harness>
    );
    await userEvent.click(screen.getByRole("button", { name: "Edit as JSON" }));
    expect(readConfig()).toEqual({ toolName: "calculator", argsTemplate: '{"expression":"1+1"}' });
    await userEvent.click(screen.getByRole("button", { name: "Use a form" }));
    expect(confirm).toHaveBeenCalled();
    expect(readConfig()).toEqual({ toolName: "calculator", argsTemplate: "{}", argValues: {} });
  });

  it("says so when the schema cannot be a form", () => {
    render(
      <Harness initial={{ argValues: {} }}>
        {(config, setConfig) => <McpToolArgsForm toolName="odd" inputSchema={{ type: "array" }} config={config} setConfig={setConfig} />}
      </Harness>
    );
    expect(screen.getByTestId("mcp-args-form-unsupported")).toHaveTextContent("cannot be shown as a form");
  });
});

const spec = parseOpenApiDocument({
  openapi: "3.0.0",
  info: { title: "Desk" },
  servers: [{ url: "https://desk.example.com/api" }],
  components: { securitySchemes: { key: { type: "apiKey", in: "query", name: "api_key" } } },
  security: [{ key: [] }],
  paths: {
    "/tickets/{id}": {
      patch: {
        operationId: "updateTicket",
        summary: "Update a ticket",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "notify", in: "query", schema: { type: "boolean" } }
        ],
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { status: { type: "string", enum: ["open", "closed"] } } } } } }
      }
    }
  }
});

const specView = {
  id: "oas_1",
  projectId: "default",
  name: "Desk",
  sourceUrl: null,
  baseUrl: spec.baseUrl,
  title: "Desk",
  version: "",
  operationCount: 1,
  warnings: [],
  createdBy: null,
  createdAt: "",
  updatedAt: "",
  fetchedAt: "",
  operations: spec.operations
};

const nodeConfig = {
  method: "PATCH",
  urlTemplate: "https://desk.example.com/api/tickets/",
  secretAuth: { type: "query", name: "api_key" },
  openapiOperation: { specId: "oas_1", operationId: "updateTicket", method: "PATCH", path: "/tickets/{id}" },
  operationValues: {}
};

describe("OpenApiOperationForm", () => {
  it("builds the request from the operation's form", async () => {
    vi.mocked(api.fetchOpenApiSpec).mockResolvedValue({ spec: specView });
    render(<Harness initial={nodeConfig}>{(config, setConfig) => <OpenApiOperationForm config={config} setConfig={setConfig} />}</Harness>);
    await screen.findByTestId("openapi-operation-form");
    expect(screen.getByText("Update a ticket")).toBeInTheDocument();
    expect(screen.getByText("PATCH /tickets/{id}")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("id"), "{{{{ webhook.id }}");
    await userEvent.selectOptions(screen.getByLabelText("notify"), "true");
    await userEvent.selectOptions(screen.getByLabelText("status"), "closed");
    const config = readConfig();
    expect(config.urlTemplate).toBe("https://desk.example.com/api/tickets/{{ webhook.id }}?notify=true");
    expect(JSON.parse(String(config.bodyTemplate))).toEqual({ status: "closed" });
    expect(config.operationValues).toEqual({ "path.id": "{{ webhook.id }}", "query.notify": true, "body.status": "closed" });
    expect(screen.getByText(/as the api_key query parameter/)).toBeInTheDocument();
  });

  it("keeps the node's request when the API is gone, and can detach from it", async () => {
    vi.mocked(api.fetchOpenApiSpec).mockRejectedValue(new Error("OpenAPI spec not found"));
    render(<Harness initial={nodeConfig}>{(config, setConfig) => <OpenApiOperationForm config={config} setConfig={setConfig} />}</Harness>);
    await screen.findByTestId("openapi-operation-missing");
    await userEvent.click(screen.getByRole("button", { name: "Edit the request directly" }));
    await waitFor(() => expect(readConfig().openapiOperation).toBeUndefined());
    expect(readConfig().urlTemplate).toBe(nodeConfig.urlTemplate);
  });
});
