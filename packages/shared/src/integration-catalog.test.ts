import { describe, expect, it } from "vitest";
import {
  buildOperationRequest,
  catalogEntryLabel,
  jsonTemplateFromForm,
  normalizeApiBaseUrl,
  OpenApiSpecError,
  OPENAPI_MAX_OPERATIONS,
  parseOpenApiDocument,
  readHttpSecretAuth,
  readOpenApiOperationRef
} from "./integration-catalog";

const spec = {
  openapi: "3.0.3",
  info: { title: "Tickets", version: "1.2.0" },
  servers: [{ url: "https://{region}.tickets.example.com/v1/", variables: { region: { default: "eu" } } }],
  components: {
    securitySchemes: {
      key: { type: "apiKey", in: "header", name: "X-API-Key" },
      bearer: { type: "http", scheme: "bearer" }
    },
    schemas: {
      Ticket: {
        type: "object",
        required: ["title"],
        properties: {
          title: { type: "string" },
          priority: { type: "integer" },
          urgent: { type: "boolean" },
          labels: { type: "array", items: { type: "string" } },
          owner: { $ref: "#/components/schemas/Owner" }
        }
      },
      Owner: { type: "object", properties: { email: { type: "string" }, manager: { $ref: "#/components/schemas/Owner" } } }
    },
    parameters: {
      Limit: { name: "limit", in: "query", schema: { type: "integer" } }
    }
  },
  security: [{ key: [] }],
  paths: {
    "/tickets": {
      get: { operationId: "listTickets", summary: "List tickets", parameters: [{ $ref: "#/components/parameters/Limit" }, { name: "session", in: "cookie" }] },
      post: {
        operationId: "createTicket",
        summary: "Create a ticket",
        security: [{ bearer: [] }],
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/Ticket" } } } }
      }
    },
    "/tickets/{ticketId}": {
      parameters: [{ name: "ticketId", in: "path", required: true, schema: { type: "string" } }],
      get: { summary: "Get one ticket", security: [] },
      delete: { operationId: "listTickets", parameters: [{ name: "X-Trace", in: "header", schema: { type: "string" } }, { name: "Authorization", in: "header" }] },
      head: { summary: "ignored" }
    }
  }
};

describe("parseOpenApiDocument", () => {
  it("reads operations, parameters, bodies, auth and the base URL", () => {
    const catalog = parseOpenApiDocument(spec);
    expect(catalog.title).toBe("Tickets");
    expect(catalog.baseUrl).toBe("https://eu.tickets.example.com/v1");
    expect(catalog.operations.map((op) => `${op.method} ${op.id}`)).toEqual([
      "GET listTickets",
      "POST createTicket",
      "GET get_tickets_ticketId",
      "DELETE listTickets_2"
    ]);
    const [list, create, getOne, remove] = catalog.operations;
    expect(list!.parameters).toEqual([{ name: "limit", in: "query", required: false, schema: { type: "integer" } }]);
    expect(list!.auth).toEqual({ type: "header", name: "X-API-Key" });
    expect(create!.auth).toEqual({ type: "bearer" });
    expect(create!.requestBody?.json).toBe(true);
    expect(create!.requestBody?.required).toBe(true);
    // The cyclic ref becomes "any value" instead of looping.
    const owner = (create!.requestBody!.schema.properties as Record<string, Record<string, unknown>>).owner!;
    expect((owner.properties as Record<string, unknown>).manager).toBeDefined();
    expect(getOne!.auth).toBeNull();
    expect(getOne!.parameters.map((p) => `${p.in}:${p.name}`)).toEqual(["path:ticketId"]);
    // Authorization is never a form field; the secret sets it.
    expect(remove!.parameters.map((p) => `${p.in}:${p.name}`)).toEqual(["path:ticketId", "header:X-Trace"]);
    expect(catalog.warnings).toEqual(expect.arrayContaining(["Cookie parameters are not supported and were left out.", "HEAD operations are not supported and were left out."]));
  });

  it("refuses Swagger 2 and documents without operations", () => {
    expect(() => parseOpenApiDocument({ swagger: "2.0", paths: {} })).toThrow(/Swagger 2.0/);
    expect(() => parseOpenApiDocument({ openapi: "3.1.0", paths: {} })).toThrow(OpenApiSpecError);
    expect(() => parseOpenApiDocument("text")).toThrow(OpenApiSpecError);
    expect(() => parseOpenApiDocument({ openapi: "4.0.0", paths: {} })).toThrow(/not supported/);
  });

  it("resolves a relative server URL against the spec URL and refuses one with credentials", () => {
    const relative = parseOpenApiDocument({ ...spec, servers: [{ url: "/api" }] }, { sourceUrl: "https://docs.example.com/spec.json" });
    expect(relative.baseUrl).toBe("https://docs.example.com/api");
    const noServer = parseOpenApiDocument({ ...spec, servers: [{ url: "https://user:pw@x.example.com" }] });
    expect(noServer.baseUrl).toBe("");
    expect(noServer.warnings.join(" ")).toMatch(/user name or password/);
  });

  it("caps the number of operations", () => {
    const paths: Record<string, unknown> = {};
    for (let i = 0; i < OPENAPI_MAX_OPERATIONS + 3; i += 1) paths[`/r${i}`] = { get: {} };
    const catalog = parseOpenApiDocument({ openapi: "3.0.0", info: { title: "Big" }, servers: [{ url: "https://x.example.com" }], paths });
    expect(catalog.operations).toHaveLength(OPENAPI_MAX_OPERATIONS);
    expect(catalog.warnings.join(" ")).toMatch(/3 were left out/);
  });

  it("maps basic, query keys and OAuth 2 and reports unsupported schemes", () => {
    const withSchemes = (scheme: Record<string, unknown>) =>
      parseOpenApiDocument({ ...spec, components: { securitySchemes: { s: scheme } }, security: [{ s: [] }] }).operations[0]!;
    expect(withSchemes({ type: "http", scheme: "basic" }).auth).toEqual({ type: "basic" });
    expect(withSchemes({ type: "apiKey", in: "query", name: "api_key" }).auth).toEqual({ type: "query", name: "api_key" });
    expect(withSchemes({ type: "oauth2", flows: {} }).auth).toEqual({ type: "bearer" });
    const cookie = parseOpenApiDocument({ ...spec, components: { securitySchemes: { s: { type: "apiKey", in: "cookie", name: "sid" } } }, security: [{ s: [] }] });
    expect(cookie.operations[0]!.auth).toBeNull();
    expect(cookie.warnings.join(" ")).toMatch(/API key in cookie/);
  });
});

describe("buildOperationRequest", () => {
  const catalog = parseOpenApiDocument(spec);
  const [list, create, getOne, remove] = catalog.operations;

  it("fills the path, query and headers, encoding literals and keeping expressions", () => {
    const get = buildOperationRequest(getOne!, catalog.baseUrl, { "path.ticketId": "a b/c" });
    expect(get.urlTemplate).toBe("https://eu.tickets.example.com/v1/tickets/a%20b%2Fc");
    expect(get.errors).toEqual({});
    const templated = buildOperationRequest(getOne!, catalog.baseUrl, { "path.ticketId": "id-{{ webhook.id }}" });
    // A plain path is encoded when it renders; any other expression is kept as written.
    expect(templated.urlTemplate).toBe("https://eu.tickets.example.com/v1/tickets/id-{{ encodeURIComponent(webhook.id) }}");
    const custom = buildOperationRequest(getOne!, catalog.baseUrl, { "path.ticketId": "{{ $json.id }}" });
    expect(custom.urlTemplate).toBe("https://eu.tickets.example.com/v1/tickets/{{ $json.id }}");
    const listed = buildOperationRequest(list!, catalog.baseUrl + "/", { "query.limit": "10" });
    expect(listed.urlTemplate).toBe("https://eu.tickets.example.com/v1/tickets?limit=10");
    expect(JSON.parse(listed.headersTemplate)).toEqual({ Accept: "application/json" });
    expect(listed.bodyTemplate).toBe("");
    const deleted = buildOperationRequest(remove!, catalog.baseUrl, { "path.ticketId": "7", "header.X-Trace": "{{ vars.trace }}" });
    expect(deleted.method).toBe("DELETE");
    expect(JSON.parse(deleted.headersTemplate)).toEqual({ "X-Trace": "{{ JSON.stringify(String(vars.trace)).slice(1, -1) }}", Accept: "application/json" });
  });

  it("reports required values that are missing", () => {
    expect(buildOperationRequest(getOne!, catalog.baseUrl, {}).errors).toEqual({ "path.ticketId": "Required" });
    expect(buildOperationRequest(create!, catalog.baseUrl, {}).errors).toEqual({ "body.title": "Required" });
  });

  it("builds a JSON body with typed values and bare expressions", () => {
    const built = buildOperationRequest(create!, catalog.baseUrl, {
      "body.title": "Printer \"jam\" {{ webhook.room }}",
      "body.priority": "{{ webhook.priority }}",
      "body.urgent": true,
      "body.labels": ["ops", "", "hw"],
      "body.owner.email": "a@example.com"
    });
    expect(built.errors).toEqual({});
    expect(built.method).toBe("POST");
    expect(built.bodyTemplate).toContain('"priority": {{ webhook.priority }}');
    const rendered = built.bodyTemplate.replace("{{ webhook.priority }}", "3").replace("{{ JSON.stringify(String(webhook.room)).slice(1, -1) }}", "B2");
    expect(JSON.parse(rendered)).toEqual({ title: 'Printer "jam" B2', priority: 3, urgent: true, labels: ["ops", "hw"], owner: { email: "a@example.com" } });
    expect(JSON.parse(built.headersTemplate)["Content-Type"]).toBe("application/json");
  });

  it("checks literal numbers", () => {
    const built = buildOperationRequest(create!, catalog.baseUrl, { "body.title": "x", "body.priority": "1.5" });
    expect(built.errors).toEqual({ "body.priority": "Enter a whole number or an expression" });
  });

  it("sends a non-JSON body as written with its content type", () => {
    const op = parseOpenApiDocument({
      openapi: "3.0.0",
      servers: [{ url: "https://x.example.com" }],
      paths: { "/upload": { put: { requestBody: { content: { "text/csv": { schema: { type: "string" } } } } } } }
    }).operations[0]!;
    const built = buildOperationRequest(op, "https://x.example.com", { body: "a,b\n1,2" });
    expect(built.bodyTemplate).toBe("a,b\n1,2");
    expect(JSON.parse(built.headersTemplate)["Content-Type"]).toBe("text/csv");
  });
});

describe("jsonTemplateFromForm", () => {
  const schema = {
    type: "object",
    required: ["a"],
    properties: { a: { type: "number" }, b: { type: "string" }, c: { type: "object" }, d: { type: "boolean" } }
  };
  it("leaves out empty optional fields and keeps an explicit false", () => {
    const built = jsonTemplateFromForm(schema, { a: "2", d: false });
    expect(JSON.parse(built.template)).toEqual({ a: 2, d: false });
    expect(jsonTemplateFromForm(schema, {}).errors).toEqual({ a: "Required" });
    expect(jsonTemplateFromForm({ type: "object" }, {}).template).toBe("{}");
  });
  it("takes JSON or an expression for an object field", () => {
    expect(jsonTemplateFromForm(schema, { a: "1", c: "{bad" }).errors).toEqual({ c: "Not valid JSON" });
    expect(jsonTemplateFromForm(schema, { a: "1", c: "{{ results.x }}" }).template).toContain('"c": {{ results.x }}');
  });
});

describe("helpers", () => {
  it("labels, base URLs, stored references and secret auth", () => {
    expect(catalogEntryLabel("GitHub", "create_issue")).toBe("GitHub · create_issue");
    expect(normalizeApiBaseUrl(" https://api.example.com/v2/?x=1 ")).toBe("https://api.example.com/v2");
    expect(() => normalizeApiBaseUrl("ftp://x")).toThrow(OpenApiSpecError);
    expect(() => normalizeApiBaseUrl("https://u:p@x.example.com")).toThrow(/user name or password/);
    expect(readOpenApiOperationRef({ openapiOperation: { specId: "s", operationId: "o", method: "get", path: "/x" } })).toEqual({
      specId: "s",
      operationId: "o",
      method: "GET",
      path: "/x",
      baseUrl: ""
    });
    expect(readOpenApiOperationRef({ openapiOperation: { specId: "s" } })).toBeNull();
    expect(readHttpSecretAuth(undefined)).toBeNull();
    expect(readHttpSecretAuth({ type: "query", name: "key" })).toEqual({ type: "query", name: "key" });
    expect(readHttpSecretAuth({ type: "header", name: "bad header" })).toMatch(/header name/);
    expect(readHttpSecretAuth({ type: "header", name: "Cookie" })).toMatch(/may not be/);
    expect(readHttpSecretAuth({ type: "digest" })).toMatch(/must be/);
  });
});

describe("operationFormSchema", () => {
  it("groups parameters and the body so form paths match buildOperationRequest", async () => {
    const { operationFormSchema } = await import("./integration-catalog");
    const catalog = parseOpenApiDocument(spec);
    const create = catalog.operations[1]!;
    const schema = operationFormSchema(create) as { properties: Record<string, { title?: string; properties?: Record<string, unknown> }>; required?: string[] };
    expect(Object.keys(schema.properties)).toEqual(["body"]);
    expect(schema.required).toEqual(["body"]);
    expect(Object.keys(schema.properties.body!.properties!)).toEqual(["title", "priority", "urgent", "labels", "owner"]);
    const remove = operationFormSchema(catalog.operations[3]!) as typeof schema;
    expect(Object.keys(remove.properties)).toEqual(["path", "header"]);
    expect(remove.required).toEqual(["path"]);
    expect(remove.properties.header!.title).toBe("Headers");
  });

  it("nests deep body objects the same way the form does", () => {
    const deep = { type: "object", properties: { a: { type: "object", properties: { b: { type: "object", properties: { c: { type: "object", properties: { d: { type: "string" } } } } } } } } };
    // Root level 0: a(0) b(1) c(2) have fields, d is a string at level 3.
    expect(JSON.parse(jsonTemplateFromForm(deep, { "a.b.c.d": "x" }).template)).toEqual({ a: { b: { c: { d: "x" } } } });
    // Started one level down (an operation body), c sits at level 3 and still has fields; one more level would be JSON.
    const deeper = { type: "object", properties: { a: { type: "object", properties: { b: { type: "object", properties: { c: { type: "object", properties: { d: { type: "object", properties: { e: { type: "string" } } } } } } } } } } };
    expect(JSON.parse(jsonTemplateFromForm(deeper, { "a.b.c.d": '{"e":"y"}' }, { startLevel: 1 }).template)).toEqual({ a: { b: { c: { d: { e: "y" } } } } });
  });
});

describe("schemas that expand too far", () => {
  it("refuses a small spec whose references grow exponentially", () => {
    const schemas: Record<string, unknown> = {};
    for (let level = 0; level < 7; level += 1) {
      const properties: Record<string, unknown> = {};
      for (let index = 0; index < 10; index += 1) properties[`p${index}`] = level < 6 ? { $ref: `#/components/schemas/S${level + 1}` } : { type: "string" };
      schemas[`S${level}`] = { type: "object", properties };
    }
    const document = {
      openapi: "3.0.3",
      info: { title: "Bomb", version: "1" },
      servers: [{ url: "https://bomb.example.com" }],
      paths: { "/x": { post: { operationId: "x", requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/S0" } } } } } } },
      components: { schemas }
    };
    expect(JSON.stringify(document).length).toBeLessThan(5000);
    const started = Date.now();
    expect(() => parseOpenApiDocument(document)).toThrow(/expand too far/);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe("names from a spec or a tool schema never become expressions", () => {
  it("leaves out parameters and paths with {{ or }} (and paths with ? or #), with a warning", () => {
    const catalog = parseOpenApiDocument({
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      servers: [{ url: "https://api.example.com" }],
      paths: {
        "/ok": { get: { operationId: "ok", parameters: [{ name: "{{ $vars.apiToken }}", in: "query" }, { name: "q", in: "query" }] } },
        "/u/{{x}}": { get: { operationId: "bad" } },
        "/v?x=1": { get: { operationId: "query" } }
      }
    });
    expect(catalog.operations.map((operation) => operation.id)).toEqual(["ok"]);
    expect(catalog.operations[0]!.parameters.map((parameter) => parameter.name)).toEqual(["q"]);
    expect(catalog.warnings.join(" ")).toMatch(/\{\{ or \}\} were left out/);
    expect(catalog.warnings.join(" ")).toMatch(/Paths with/);
  });

  it("never writes a schema key with {{ or }} into a body or arguments template", () => {
    const schema = {
      type: "object",
      required: ["meta"],
      properties: {
        name: { type: "string" },
        "{{ $vars.apiToken }}": { type: "string" },
        meta: { type: "object", required: ["{{ results.other.secret }}"], properties: { "{{ results.other.secret }}": { type: "object", properties: {} } } }
      }
    };
    const { template } = jsonTemplateFromForm(schema, { name: "a", "{{ $vars.apiToken }}": "b" });
    expect(template).not.toContain("{{");
    expect(template).toContain('"name": "a"');
  });
});
