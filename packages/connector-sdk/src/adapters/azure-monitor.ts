import type { ConnectorAdapter, ConnectorExecutionContext } from "../types";

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toStringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function toBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function toPositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : fallback;
}

function parseBearerToken(secretValue: string): string {
  const trimmed = secretValue.trim();
  if (!trimmed) {
    return "";
  }

  if (/^bearer\s+/i.test(trimmed)) {
    return trimmed.replace(/^bearer\s+/i, "").trim();
  }

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const token = toStringValue(parsed.accessToken ?? parsed.access_token ?? parsed.token ?? parsed.bearerToken);
    if (token) {
      return token;
    }
  } catch {
    // ignore
  }

  return trimmed;
}

function buildDemoDocuments(config: Record<string, unknown>) {
  const operation = toStringValue(config.operation) || "query_logs";
  return [
    {
      id: `azure-monitor-${operation}-1`,
      text: `Demo Azure Monitor response for operation '${operation}'.`,
      metadata: {
        source: "azure-monitor",
        mode: "demo-fallback"
      }
    }
  ];
}

function normalizeManagementPath(pathValue: string): string {
  const trimmed = pathValue.trim();
  if (!trimmed) {
    return "/";
  }
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return trimmed;
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function tryParseJsonString(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

export class AzureMonitorConnectorAdapter implements ConnectorAdapter {
  readonly definition = {
    id: "azure-monitor",
    label: "Microsoft Azure Monitor",
    category: "azure_monitor" as const,
    description: "Queries Azure Monitor logs/metrics or sends authenticated monitor API requests.",
    configSchema: {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["query_logs", "query_metrics", "custom_request"] },
        workspaceId: { type: "string" },
        resourceId: { type: "string" },
        queryText: { type: "string" },
        timespan: { type: "string" },
        metricNames: { type: "string" },
        method: { type: "string" },
        path: { type: "string" },
        bodyTemplate: { type: "string" },
        maxRows: { type: "number" },
        useDemoFallback: { type: "boolean" }
      }
    },
    authSchema: {
      type: "object",
      properties: {
        secretRef: {
          type: "object",
          properties: {
            secretId: { type: "string" }
          }
        }
      }
    }
  };

  private async resolveToken(config: Record<string, unknown>, context: ConnectorExecutionContext): Promise<string> {
    const secretRef = toRecord(config.secretRef);
    const secretId = toStringValue(secretRef.secretId);
    const secretValue = secretId ? await context.resolveSecret({ secretId }) : undefined;
    return parseBearerToken(secretValue ?? "");
  }

  private async request(input: {
    url: string;
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    token: string;
    body?: unknown;
    headers?: Record<string, string>;
  }): Promise<Response> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${input.token}`,
      "content-type": "application/json",
      ...toRecord(input.headers)
    } as Record<string, string>;

    return fetch(input.url, {
      method: input.method,
      headers,
      body: input.body === undefined ? undefined : JSON.stringify(input.body)
    });
  }

  async testConnection(config: Record<string, unknown>, context: ConnectorExecutionContext) {
    const useDemoFallback = toBoolean(config.useDemoFallback, true);
    const token = await this.resolveToken(config, context);
    if (!token) {
      return {
        ok: useDemoFallback,
        message: useDemoFallback
          ? "No Azure credential configured. Connector will run in demo fallback mode."
          : "Azure Bearer token credential is required."
      };
    }

    try {
      const response = await this.request({
        url: "https://management.azure.com/subscriptions?api-version=2020-01-01",
        method: "GET",
        token
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 320);
        return {
          ok: false,
          message: `Azure Monitor connection failed (${response.status}): ${detail || response.statusText}`
        };
      }
      return {
        ok: true,
        message: "Azure Monitor connection successful."
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : "Azure Monitor connection failed."
      };
    }
  }

  async fetchData(config: Record<string, unknown>, context: ConnectorExecutionContext) {
    const operation = toStringValue(config.operation) || "query_logs";
    const workspaceId = toStringValue(config.workspaceId);
    const resourceId = toStringValue(config.resourceId);
    const queryText = toStringValue(config.queryText) || "Heartbeat | take 5";
    const timespan = toStringValue(config.timespan);
    const metricNames = toStringValue(config.metricNames);
    const maxRows = Math.max(1, Math.min(10_000, toPositiveInt(config.maxRows, 200)));
    const useDemoFallback = toBoolean(config.useDemoFallback, true);
    const token = await this.resolveToken(config, context);

    if (!token) {
      if (useDemoFallback) {
        return {
          documents: buildDemoDocuments(config),
          raw: {
            mode: "demo-fallback",
            reason: "missing_credentials"
          }
        };
      }
      throw new Error("Azure Monitor credential is required.");
    }

    try {
      if (operation === "query_logs") {
        if (!workspaceId) {
          throw new Error("Azure Monitor query_logs requires workspaceId.");
        }
        const body: Record<string, unknown> = {
          query: queryText
        };
        if (timespan) {
          body.timespan = timespan;
        }
        const response = await this.request({
          url: `https://api.loganalytics.io/v1/workspaces/${encodeURIComponent(workspaceId)}/query`,
          method: "POST",
          token,
          body
        });
        const payloadText = await response.text();
        if (!response.ok) {
          throw new Error(`Azure Monitor logs query failed (${response.status}): ${payloadText.slice(0, 320)}`);
        }
        const payload = JSON.parse(payloadText) as Record<string, unknown>;
        const tables = Array.isArray(payload.tables) ? (payload.tables as Array<Record<string, unknown>>) : [];
        const documents: Array<{ id: string; text: string; metadata: Record<string, unknown> }> = [];
        for (const [tableIndex, table] of tables.entries()) {
          const columns = Array.isArray(table.columns) ? table.columns : [];
          const rows = Array.isArray(table.rows) ? table.rows.slice(0, maxRows) : [];
          const columnNames = columns.map((column) => toStringValue(toRecord(column).name));
          rows.forEach((row, rowIndex) => {
            const rowArray = Array.isArray(row) ? row : [];
            const normalized: Record<string, unknown> = {};
            for (let i = 0; i < columnNames.length; i += 1) {
              const key = columnNames[i] || `col_${i}`;
              normalized[key] = rowArray[i];
            }
            documents.push({
              id: `azure-monitor-log-${tableIndex + 1}-${rowIndex + 1}`,
              text: JSON.stringify(normalized),
              metadata: {
                source: "azure-monitor",
                operation,
                table: toStringValue(table.name) || `table_${tableIndex + 1}`
              }
            });
          });
        }
        return {
          documents,
          raw: payload
        };
      }

      if (operation === "query_metrics") {
        if (!resourceId) {
          throw new Error("Azure Monitor query_metrics requires resourceId.");
        }
        const url = new URL(`https://management.azure.com${resourceId}/providers/microsoft.insights/metrics`);
        url.searchParams.set("api-version", "2023-10-01");
        if (metricNames) {
          url.searchParams.set("metricnames", metricNames);
        }
        if (timespan) {
          url.searchParams.set("timespan", timespan);
        }
        const response = await this.request({
          url: url.toString(),
          method: "GET",
          token
        });
        const payloadText = await response.text();
        if (!response.ok) {
          throw new Error(`Azure Monitor metrics query failed (${response.status}): ${payloadText.slice(0, 320)}`);
        }
        const payload = JSON.parse(payloadText) as Record<string, unknown>;
        const values = Array.isArray(payload.value) ? payload.value : [];
        const documents = values.slice(0, maxRows).map((entry, index) => ({
          id: `azure-monitor-metric-${index + 1}`,
          text: JSON.stringify(entry),
          metadata: {
            source: "azure-monitor",
            operation,
            resourceId
          }
        }));
        return {
          documents,
          raw: payload
        };
      }

      if (operation === "custom_request") {
        const method = toStringValue(config.method).toUpperCase() || "GET";
        const path = normalizeManagementPath(toStringValue(config.path));
        const body = tryParseJsonString(toStringValue(config.bodyTemplate));
        const requestUrl = path.startsWith("http://") || path.startsWith("https://")
          ? path
          : `https://management.azure.com${path}`;
        const response = await this.request({
          url: requestUrl,
          method: (["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method) ? method : "GET") as
            | "GET"
            | "POST"
            | "PUT"
            | "PATCH"
            | "DELETE",
          token,
          body
        });
        const payloadText = await response.text();
        if (!response.ok) {
          throw new Error(`Azure Monitor custom request failed (${response.status}): ${payloadText.slice(0, 320)}`);
        }
        const payloadJson = tryParseJsonString(payloadText);
        const payload = payloadJson ?? payloadText;
        const documents = [
          {
            id: "azure-monitor-custom-1",
            text: typeof payload === "string" ? payload : JSON.stringify(payload),
            metadata: {
              source: "azure-monitor",
              operation,
              method,
              path
            }
          }
        ];
        return {
          documents,
          raw: payload
        };
      }

      throw new Error(`Unsupported Azure Monitor operation '${operation}'.`);
    } catch (error) {
      if (useDemoFallback) {
        return {
          documents: buildDemoDocuments(config),
          raw: {
            mode: "demo-fallback",
            reason: error instanceof Error ? error.message : "azure_monitor_error"
          }
        };
      }
      throw error;
    }
  }
}
