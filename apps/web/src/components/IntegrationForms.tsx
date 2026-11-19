/**
 * Forms generated from schemas for nodes added from the integration catalog:
 * - an MCP Tool node bound to one tool gets a form from the tool's input JSON Schema, which writes `argsTemplate`;
 * - an HTTP Request node made from an OpenAPI operation gets a form for the operation's path, query and header
 *   parameters and body, which writes the node's method, URL, headers and body templates.
 * Values may hold expressions (`{{ webhook.id }}`). Nothing here changes how the node runs.
 */
import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from "react";
import {
  buildOperationRequest,
  jsonTemplateFromForm,
  operationFormSchema,
  readOpenApiOperationRef,
  type CatalogFormValues,
  type OpenApiOperation
} from "@ai-orchestrator/shared";
import { fetchOpenApiSpec, type OpenApiSpecView } from "../lib/api";
import { buildSchemaForm, type FormValue } from "../lib/mcp-schema-form";
import { McpSchemaForm } from "./McpSchemaForm";

type Config = Record<string, unknown>;
type SetConfig = Dispatch<SetStateAction<Config>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Stored form values: only strings, booleans and lists of strings are kept. */
function readFormValues(raw: unknown): CatalogFormValues {
  const values: CatalogFormValues = {};
  if (!isRecord(raw)) return values;
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string" || typeof value === "boolean") values[key] = value;
    else if (Array.isArray(value)) values[key] = value.map((item) => String(item ?? ""));
  }
  return values;
}

/** Drops unset values, so a cleared field leaves nothing behind in the saved config. */
function withValue(values: CatalogFormValues, path: string, value: FormValue): CatalogFormValues {
  const next = { ...values };
  if (value === undefined || (typeof value === "string" && value === "")) delete next[path];
  else next[path] = value;
  return next;
}

const EXPRESSION_HINT = (
  <>
    Values may use expressions, such as <code>{"{{ webhook.id }}"}</code> or <code>{"{{ results.fetch.body.name }}"}</code>.
  </>
);

// ---------------------------------------------------------------------------------------------------------------------
// MCP Tool
// ---------------------------------------------------------------------------------------------------------------------

/** Whether the node edits its arguments with the generated form (set on nodes added from the catalog). */
export function usesMcpArgsForm(config: Config): boolean {
  return isRecord(config.argValues);
}

interface McpToolArgsFormProps {
  toolName: string;
  inputSchema: unknown;
  config: Config;
  setConfig: SetConfig;
}

/**
 * The tool's arguments as a form. Shown when the node keeps `argValues` (nodes from the catalog); "Edit as JSON"
 * drops them and the node's Tool Args Template field takes over, as on any MCP Tool node.
 */
export function McpToolArgsForm({ toolName, inputSchema, config, setConfig }: McpToolArgsFormProps) {
  const model = useMemo(() => buildSchemaForm(inputSchema), [inputSchema]);
  const values = readFormValues(config.argValues);
  const errors = useMemo(() => jsonTemplateFromForm(inputSchema, values).errors, [inputSchema, values]);

  if (!model.fields) {
    return (
      <div className="cfg-tip" data-testid="mcp-args-form-unsupported">
        The arguments of <code>{toolName}</code> cannot be shown as a form. Write them as JSON below.
      </div>
    );
  }

  return (
    <div className="cfg-group" data-testid="mcp-args-form">
      <h4>Arguments</h4>
      <McpSchemaForm
        fields={model.fields}
        values={values}
        errors={errors}
        onChange={(path, value) =>
          setConfig((current) => {
            const nextValues = withValue(readFormValues(current.argValues), path, value);
            return { ...current, argValues: nextValues, argsTemplate: jsonTemplateFromForm(inputSchema, nextValues).template };
          })
        }
      />
      <div className="cfg-inline-actions">
        <span className="muted">{EXPRESSION_HINT}</span>
        <button
          type="button"
          className="insp-btn"
          onClick={() =>
            setConfig((current) => {
              const { argValues: _dropped, ...rest } = current;
              return rest;
            })
          }
        >
          Edit as JSON
        </button>
      </div>
    </div>
  );
}

/** "Use a form" on an MCP Tool node that writes JSON, when the tool's schema can be a form. Replaces the JSON. */
export function McpUseFormButton({ inputSchema, config, setConfig }: Omit<McpToolArgsFormProps, "toolName">) {
  const model = useMemo(() => buildSchemaForm(inputSchema), [inputSchema]);
  if (!model.fields || model.fields.length === 0) return null;
  return (
    <button
      type="button"
      className="insp-btn"
      onClick={() => {
        const current = typeof config.argsTemplate === "string" ? config.argsTemplate.trim() : "";
        if (current && current !== "{}" && !window.confirm("Use a form for the arguments? The JSON written here is replaced.")) return;
        setConfig((existing) => ({ ...existing, argValues: {}, argsTemplate: "{}" }));
      }}
    >
      Use a form
    </button>
  );
}

// ---------------------------------------------------------------------------------------------------------------------
// HTTP Request from an OpenAPI operation
// ---------------------------------------------------------------------------------------------------------------------

/** Specs read in this session, by id (an operation form opens without a new request). */
const specCache = new Map<string, Promise<OpenApiSpecView & { operations: OpenApiOperation[] }>>();

function loadSpec(specId: string) {
  let pending = specCache.get(specId);
  if (!pending) {
    pending = fetchOpenApiSpec(specId).then((response) => response.spec);
    pending.catch(() => specCache.delete(specId));
    specCache.set(specId, pending);
  }
  return pending;
}

/** Forgets cached specs (after a refresh in the catalog dialog, and in tests). */
export function clearOpenApiSpecCache(): void {
  specCache.clear();
}

/** Whether the node was made from an OpenAPI operation (its request comes from the operation form). */
export function usesOpenApiOperation(config: Config): boolean {
  return readOpenApiOperationRef(config) !== null;
}

type SpecState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; spec: OpenApiSpecView; operation: OpenApiOperation | null };

interface OpenApiOperationFormProps {
  config: Config;
  setConfig: SetConfig;
}

export function OpenApiOperationForm({ config, setConfig }: OpenApiOperationFormProps) {
  const ref = readOpenApiOperationRef(config);
  const specId = ref?.specId ?? "";
  const operationId = ref?.operationId ?? "";
  const [state, setState] = useState<SpecState>({ status: "loading" });

  useEffect(() => {
    if (!specId) return;
    let cancelled = false;
    setState({ status: "loading" });
    loadSpec(specId).then(
      (spec) => {
        if (!cancelled) setState({ status: "ready", spec, operation: spec.operations.find((entry) => entry.id === operationId) ?? null });
      },
      (error: unknown) => {
        if (!cancelled) setState({ status: "error", message: error instanceof Error ? error.message : String(error) });
      }
    );
    return () => {
      cancelled = true;
    };
  }, [specId, operationId]);

  const operation = state.status === "ready" ? state.operation : null;
  const schema = useMemo(() => (operation ? operationFormSchema(operation) : null), [operation]);
  const model = useMemo(() => (schema ? buildSchemaForm(schema) : null), [schema]);
  const values = readFormValues(config.operationValues);
  const baseUrl = state.status === "ready" ? state.spec.baseUrl : "";
  const errors = useMemo(() => (operation ? buildOperationRequest(operation, baseUrl, values).errors : {}), [operation, baseUrl, values]);

  if (!ref) return null;

  const detach = (
    <button
      type="button"
      className="insp-btn"
      onClick={() =>
        setConfig((current) => {
          const { openapiOperation: _ref, operationValues: _values, ...rest } = current;
          return rest;
        })
      }
    >
      Edit the request directly
    </button>
  );

  const summary = (
    <div className="cfg-operation-summary" data-testid="openapi-operation-summary">
      <strong>{operation?.summary ?? ref.operationId}</strong>
      <code>
        {ref.method} {ref.path}
      </code>
      {state.status === "ready" ? <small className="kb-subtle">From {state.spec.name}</small> : null}
    </div>
  );

  if (state.status === "loading") {
    return (
      <div className="cfg-group">
        {summary}
        <div className="cfg-tip">Loading the operation…</div>
      </div>
    );
  }
  if (state.status === "error" || !operation || !model?.fields) {
    return (
      <div className="cfg-group" data-testid="openapi-operation-missing">
        {summary}
        <div className="cfg-tip">
          {state.status === "error"
            ? "The API this node was made from is not available to you, or was removed. The node still runs with the request it has."
            : "This operation is no longer in the API's spec. The node still runs with the request it has."}
        </div>
        <div className="cfg-inline-actions">{detach}</div>
      </div>
    );
  }

  return (
    <div className="cfg-group" data-testid="openapi-operation-form">
      {summary}
      {model.fields.length === 0 ? (
        <div className="cfg-tip">This operation takes no parameters.</div>
      ) : (
        <McpSchemaForm
          fields={model.fields}
          values={values}
          errors={errors}
          onChange={(path, value) =>
            setConfig((current) => {
              const nextValues = withValue(readFormValues(current.operationValues), path, value);
              const request = buildOperationRequest(operation, baseUrl, nextValues);
              return {
                ...current,
                operationValues: nextValues,
                method: request.method,
                urlTemplate: request.urlTemplate,
                headersTemplate: request.headersTemplate,
                bodyTemplate: request.bodyTemplate
              };
            })
          }
        />
      )}
      <div className="cfg-tip">
        {EXPRESSION_HINT}
        {!baseUrl ? " The API has no base URL yet: set it under Add an API… in the palette." : null}
      </div>
      <details className="cfg-advanced cfg-fold">
        <summary>Request</summary>
        <div className="cfg-advanced-body">
          <code className="cfg-request-preview" data-testid="openapi-request-preview">
            {toText(config.method)} {toText(config.urlTemplate)}
          </code>
          <div className="cfg-inline-actions">{detach}</div>
        </div>
      </details>
    </div>
  );
}

function toText(value: unknown): string {
  return typeof value === "string" ? value : "";
}
