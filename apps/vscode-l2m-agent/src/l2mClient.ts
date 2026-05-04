import type {
  L2MAgentConfig,
  L2MExecuteInput,
  L2MSseEvent,
  L2MStreamHandlers,
  L2MWebhookPayload
} from "./protocol";

interface L2MHttpRequest {
  response: Response;
  signal: AbortSignal;
  deadlineAt: number;
  abort: () => void;
  cleanup: () => void;
}

export class L2MClient {
  constructor(private readonly config: L2MAgentConfig) {}

  async execute(input: L2MExecuteInput, handlers: L2MStreamHandlers = {}): Promise<unknown> {
    const payload = this.buildPayload(input);
    if (this.config.streamResponses) {
      return this.executeStream(payload, handlers);
    }
    return this.executeJson(payload);
  }

  private buildPayload(input: L2MExecuteInput): L2MWebhookPayload {
    return {
      workflow_id: this.config.workflowId || undefined,
      session_id: input.sessionId,
      system_prompt: input.systemPrompt,
      user_prompt: input.userPrompt,
      variables: input.variables,
      executionTimeoutMs: this.config.requestTimeoutMs
    };
  }

  private async executeJson(payload: L2MWebhookPayload): Promise<unknown> {
    const request = await this.postJson("/api/webhooks/execute", payload);
    try {
      const text = await withRequestDeadline(request.response.text(), request, this.config.requestTimeoutMs);
      const parsed = parseJsonSafely(text);
      if (!request.response.ok) {
        throw new Error(extractErrorMessage(parsed) || `L2M request failed (${request.response.status})`);
      }
      return parsed ?? text;
    } catch (error) {
      if (request.signal.aborted) {
        throw new Error(`L2M request timed out after ${this.config.requestTimeoutMs}ms.`);
      }
      throw error;
    } finally {
      request.cleanup();
    }
  }

  private async executeStream(payload: L2MWebhookPayload, handlers: L2MStreamHandlers): Promise<unknown> {
    const request = await this.postJson("/api/webhooks/execute/stream", payload);
    try {
      if (!request.response.ok) {
        const text = await withRequestDeadline(request.response.text(), request, this.config.requestTimeoutMs);
        const parsed = parseJsonSafely(text);
        throw new Error(extractErrorMessage(parsed) || `L2M stream failed (${request.response.status})`);
      }
      if (!request.response.body) {
        throw new Error("L2M stream response did not include a readable body.");
      }

      const reader = request.response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finalResult: unknown = undefined;
      let streamError = "";

      while (true) {
        const { done, value } = await withRequestDeadline(
          reader.read(),
          request,
          this.config.requestTimeoutMs
        );
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        buffer = buffer.replace(/\r\n/g, "\n");

        let separatorIndex = buffer.indexOf("\n\n");
        while (separatorIndex >= 0) {
          const rawEvent = buffer.slice(0, separatorIndex);
          buffer = buffer.slice(separatorIndex + 2);

          const event = parseSseEvent(rawEvent);
          if (event) {
            handlers.onEvent?.(event);
            const maybeResult = handleKnownEvent(event, handlers);
            if (event.event === "result") {
              finalResult = maybeResult ?? event.payload;
            }
            if (event.event === "error") {
              streamError = extractErrorMessage(event.payload) || "L2M stream returned an error.";
            }
          }

          separatorIndex = buffer.indexOf("\n\n");
        }
      }

      const tail = decoder.decode();
      if (tail) {
        buffer += tail;
      }
      const finalEvent = parseSseEvent(buffer.trim());
      if (finalEvent) {
        handlers.onEvent?.(finalEvent);
        const maybeResult = handleKnownEvent(finalEvent, handlers);
        if (finalEvent.event === "result") {
          finalResult = maybeResult ?? finalEvent.payload;
        } else if (finalEvent.event === "error") {
          streamError = extractErrorMessage(finalEvent.payload) || "L2M stream returned an error.";
        }
      }

      if (streamError) {
        throw new Error(streamError);
      }

      const resultError = extractWorkflowResultError(finalResult);
      if (resultError) {
        throw new Error(resultError);
      }

      return finalResult;
    } catch (error) {
      if (request.signal.aborted) {
        throw new Error(`L2M request timed out after ${this.config.requestTimeoutMs}ms.`);
      }
      throw error;
    } finally {
      request.cleanup();
    }
  }

  private async postJson(
    path: string,
    payload: L2MWebhookPayload
  ): Promise<L2MHttpRequest> {
    const controller = new AbortController();
    const deadlineAt = Date.now() + this.config.requestTimeoutMs;
    const timeout = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);

    try {
      const response = await fetch(`${this.config.apiBaseUrl}${path}`, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      return {
        response,
        signal: controller.signal,
        deadlineAt,
        abort: () => controller.abort(),
        cleanup: () => clearTimeout(timeout)
      };
    } catch (error) {
      clearTimeout(timeout);
      if (controller.signal.aborted) {
        throw new Error(`L2M request timed out after ${this.config.requestTimeoutMs}ms.`);
      }
      throw error;
    }
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "content-type": "application/json"
    };
    if (this.config.authToken) {
      headers.authorization = `Bearer ${this.config.authToken}`;
    }
    return headers;
  }
}

function withRequestDeadline<T>(
  operation: Promise<T>,
  request: L2MHttpRequest,
  timeoutMs: number
): Promise<T> {
  const remainingMs = request.deadlineAt - Date.now();
  if (remainingMs <= 0) {
    request.abort();
    return Promise.reject(new Error(`L2M request timed out after ${timeoutMs}ms.`));
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      request.abort();
      reject(new Error(`L2M request timed out after ${timeoutMs}ms.`));
    }, remainingMs);
  });

  return Promise.race([operation, timeoutPromise]).finally(() => {
    if (timeout) {
      clearTimeout(timeout);
    }
  });
}

function parseSseEvent(raw: string): L2MSseEvent | null {
  if (!raw.trim()) {
    return null;
  }

  let event = "message";
  const dataLines: string[] = [];

  for (const line of raw.split("\n")) {
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim() || "message";
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }

  const data = dataLines.join("\n");
  return {
    event,
    payload: parseJsonSafely(data) ?? data
  };
}

function handleKnownEvent(event: L2MSseEvent, handlers: L2MStreamHandlers): unknown {
  const payload = event.payload;
  if (event.event === "execution_started") {
    handlers.onProgress?.("Execution started.");
  } else if (event.event === "node_start") {
    const nodeId = valueAt(payload, "nodeId");
    const nodeType = valueAt(payload, "nodeType");
    handlers.onProgress?.(`Started ${nodeId || nodeType || "node"}.`);
  } else if (event.event === "node_complete") {
    const nodeId = valueAt(payload, "nodeId");
    const status = valueAt(payload, "status");
    handlers.onProgress?.(`Completed ${nodeId || "node"}${status ? ` (${status})` : ""}.`);
  } else if (event.event === "llm_delta") {
    const delta = valueAt(payload, "delta");
    if (typeof delta === "string" && delta) {
      handlers.onDelta?.(delta);
    }
  }
  return payload;
}

function parseJsonSafely(value: string): unknown {
  if (!value.trim()) {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractErrorMessage(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }

  const record = value as Record<string, unknown>;
  return typeof record.error === "string"
    ? record.error
    : typeof record.message === "string"
      ? record.message
      : "";
}

function extractWorkflowResultError(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }

  const record = value as Record<string, unknown>;
  if (record.status !== "error") {
    return "";
  }

  return extractErrorMessage(record) || "L2M workflow execution failed.";
}

function valueAt(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}
