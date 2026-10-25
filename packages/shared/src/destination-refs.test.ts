import { describe, expect, it } from "vitest";
import {
  connectorAddressInSecret,
  connectorDestinationRef,
  describeDestinationSummary,
  destinationHostOfSetting,
  mcpServerDestinationRef,
  resolveDestination
} from "./data-destinations";

/** Phase 16 (p3) — call-time refs shared by the "not classified yet" list and the engine. */
describe("call-time destination refs", () => {
  it("reads hosts from URLs and bare hosts; templates and paths give nothing", () => {
    expect(destinationHostOfSetting("https://API.Example.com:8443/v1")).toBe("api.example.com");
    expect(destinationHostOfSetting("smtp.example.com")).toBe("smtp.example.com");
    expect(destinationHostOfSetting("https://{{vars.host}}/x")).toBeUndefined();
    expect(destinationHostOfSetting("example.com/path")).toBeUndefined();
    expect(destinationHostOfSetting(42)).toBeUndefined();
  });

  it("connectors: the host their handler really calls, else an unknown host (public)", () => {
    expect(connectorDestinationRef("smtp_send_email", { host: "mail.corp.internal" })).toEqual({ kind: "connector", id: "smtp_send_email", host: "mail.corp.internal" });
    // Slack: the webhook URL in webhook mode (the default), slack.com for a bot token.
    expect(connectorDestinationRef("slack_send_message", { webhookUrl: "https://hooks.slack.com/services/T/B/x" })?.host).toBe("hooks.slack.com");
    expect(connectorDestinationRef("slack_send_message", { authType: "bot", secretRef: { secretId: "bot" } })?.host).toBe("slack.com");
    expect(connectorDestinationRef("slack_send_message", { secretRef: { secretId: "hook" } })?.host).toBe("");
    // An address that is set but templated: unknown, never a default.
    expect(connectorDestinationRef("slack_send_message", { webhookUrl: "{{vars.hook}}" })?.host).toBe("");
    const unknown = connectorDestinationRef("postgres_query", { secretRef: { secretId: "db" } })!;
    expect(unknown).toEqual({ kind: "connector", id: "postgres_query", host: "" });
    expect(resolveDestination(unknown, []).tier).toBe("public");
    // An unknown type is never read for a host.
    expect(connectorDestinationRef("x_node", { url: "http://127.0.0.1/" })?.host).toBe("");
    // Redis without a URL talks to localhost (local); S3 to the bucket's regional host.
    expect(resolveDestination(connectorDestinationRef("redis_command", {})!, []).tier).toBe("local");
    expect(connectorDestinationRef("aws_s3_put_object", { bucket: "b1", region: "eu-west-1" })?.host).toBe("b1.s3.eu-west-1.amazonaws.com");
    // Demo stubs with no network: nothing to judge.
    expect(connectorDestinationRef("connector_source", { connectorId: "sql-db" })).toBeNull();
    expect(connectorDestinationRef("connector_source", { connectorId: "qdrant", connectorConfig: { endpoint: "https://q.corp.internal" } })?.host).toBe("q.corp.internal");
    expect(connectorDestinationRef("azure_monitor_http", {})?.host).toBe("api.loganalytics.io");
  });

  it("an unused URL-like key never decides a connector's destination (fixed-vendor and keyed connectors alike)", () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["airtable_create_record", { baseId: "app1", table: "t", url: "http://127.0.0.1/" }, "api.airtable.com"],
      ["twilio_send_sms", { to: "+1", body: "x", extra: { host: "10.0.0.5" } }, "api.twilio.com"],
      ["stripe_create_customer", { email: "a@b.c", metadata: { endpoint: "https://intranet.internal/x" } }, "api.stripe.com"],
      ["notion_create_page", { endpoint: "http://localhost/" }, "api.notion.com"],
      ["jira_create_issue", { url: "http://127.0.0.1/", baseUrl: "https://acme.atlassian.net" }, "acme.atlassian.net"],
      ["smtp_send_email", { url: "http://127.0.0.1/", host: "smtp.example.com" }, "smtp.example.com"],
      ["discord_send_message", { host: "127.0.0.1", webhookUrl: "https://discord.com/api/webhooks/1/x" }, "discord.com"],
      ["mysql_query", { uri: "mysql://127.0.0.1/db" }, ""]
    ];
    for (const [type, config, host] of cases) {
      const ref = connectorDestinationRef(type, config)!;
      expect(ref.host, type).toBe(host);
      if (type !== "mysql_query") expect(resolveDestination(ref, []).tier, type).toBe("public");
    }
    // An address that moves the URL's authority is read as the handler would send it.
    expect(connectorDestinationRef("aws_s3_get_object", { bucket: "evil.example/x?", region: "us-east-1" })?.host).toBe("evil.example");
    expect(connectorDestinationRef("azure_monitor_http", { operation: "query_metrics", resourceId: "@evil.example/sub" })?.host).toBe("evil.example");
  });

  it("an address kept in the secret: read from the secret's value only, for Mongo and Teams", () => {
    expect(connectorAddressInSecret("mongo_operation", { secretRef: { secretId: "m" }, uri: "mongodb://127.0.0.1" })).toBe(true);
    expect(connectorDestinationRef("mongo_operation", { secretRef: { secretId: "m" }, uri: "mongodb://127.0.0.1" })?.host).toBe("");
    expect(connectorDestinationRef("mongo_operation", { secretRef: { secretId: "m" }, uri: "mongodb://127.0.0.1" }, "mongodb+srv://u:p@cluster0.mongo.example/db")?.host).toBe("cluster0.mongo.example");
    expect(connectorDestinationRef("mongo_operation", { uri: "mongodb://db.corp.internal:27017" })?.host).toBe("db.corp.internal");
    expect(connectorDestinationRef("teams_send_message", { secretRef: { secretId: "t" } }, "https://acme.webhook.office.com/x")?.host).toBe("acme.webhook.office.com");
  });

  it("MCP servers: none for the mock adapter, the endpoint host otherwise", () => {
    expect(mcpServerDestinationRef({ serverId: "mock-mcp" })).toBeNull();
    expect(mcpServerDestinationRef({ adapterId: "mock-mcp", registryServerId: "m1" })).toBeNull();
    expect(mcpServerDestinationRef({ serverId: "http-mcp", registryServerId: "gh", connection: { endpoint: "https://mcp.github.example/mcp" } })).toEqual({
      kind: "mcp_server",
      id: "gh",
      host: "mcp.github.example"
    });
    expect(mcpServerDestinationRef({ serverId: "http-mcp", connection: {} })).toEqual({ kind: "mcp_server", host: "" });
    // A stdio server is a local process: local through the built-in loopback row; an id row can still tighten it.
    const stdio = mcpServerDestinationRef({ serverId: "stdio_mcp", registryServerId: "files" })!;
    expect(stdio).toEqual({ kind: "mcp_server", id: "files", host: "localhost" });
    expect(resolveDestination(stdio, [])).toMatchObject({ tier: "local", matchedBy: "builtin" });
  });

  it("names a destination in copy by its row, else its host or id, with the tier", () => {
    expect(describeDestinationSummary({ name: "OpenAI", tier: "vendor" })).toBe("OpenAI (vendor)");
    expect(describeDestinationSummary({ host: "api.example.com", tier: "public" })).toBe("api.example.com (public)");
    expect(describeDestinationSummary({ id: "scripted", host: "", tier: "public" })).toBe("scripted (public)");
    expect(describeDestinationSummary({ tier: "public" })).toBe("an unknown host (public)");
  });
});
