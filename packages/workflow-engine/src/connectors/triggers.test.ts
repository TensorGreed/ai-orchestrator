import { describe, expect, it } from "vitest";
import { ErrorCategory, WorkflowError } from "@ai-orchestrator/shared";
import {
  executeChatTrigger,
  executeFileTrigger,
  executeFormTrigger,
  executeKafkaTrigger,
  executeManualTrigger,
  executeMcpServerTrigger,
  executeMqttTrigger,
  executeRabbitmqTrigger,
  executeRssTrigger,
  executeSseTrigger,
  type TriggerContext
} from "./triggers";
import { executePhase35TriggerNode, PHASE35_TRIGGER_NODE_TYPES } from "./triggers-dispatch";

function makeCtx(overrides: Partial<TriggerContext> = {}): TriggerContext {
  return {
    templateData: {},
    globals: {},
    webhookPayload: undefined,
    ...overrides
  };
}

describe("phase 3.5 triggers — executors", () => {
  it("manual_trigger merges testData with webhook payload (payload wins)", () => {
    const result = executeManualTrigger(
      { label: "Go", testData: { user_prompt: "default" } },
      makeCtx({ webhookPayload: { user_prompt: "from-request", extra: 1 } })
    ) as Record<string, unknown>;
    expect(result.triggered).toBe(true);
    expect(result.trigger_type).toBe("manual");
    expect(result.label).toBe("Go");
    expect(result.user_prompt).toBe("from-request");
    expect(result.extra).toBe(1);
  });

  it("form_trigger surfaces form_submission globals as fields", () => {
    const result = executeFormTrigger(
      {},
      makeCtx({
        globals: {
          form_submission: { name: "Alice", email: "a@x.dev" },
          submitted_at: "2026-04-14T00:00:00Z"
        }
      })
    ) as Record<string, unknown>;
    expect(result.triggered).toBe(true);
    expect(result.trigger_type).toBe("form");
    expect(result.submittedAt).toBe("2026-04-14T00:00:00Z");
    expect(result.name).toBe("Alice");
    expect(result.email).toBe("a@x.dev");
  });

  it("chat_trigger reads message from webhook payload and session_id", () => {
    const result = executeChatTrigger(
      { sessionNamespace: "ns" },
      makeCtx({ webhookPayload: { message: "hi", session_id: "s1", user: "u1" } })
    ) as Record<string, unknown>;
    expect(result.trigger_type).toBe("chat");
    expect(result.message).toBe("hi");
    expect(result.user_prompt).toBe("hi");
    expect(result.session_id).toBe("s1");
    expect(result.namespace).toBe("ns");
    expect(result.user).toBe("u1");
  });

  it("file_trigger exposes file_events from globals", () => {
    const result = executeFileTrigger(
      {},
      makeCtx({
        globals: {
          file_events: [{ path: "/x", event: "created" }],
          watch_path: "/data"
        }
      })
    ) as Record<string, unknown>;
    expect(result.triggered).toBe(true);
    expect(result.watchPath).toBe("/data");
    expect(result.eventCount).toBe(1);
    expect(Array.isArray(result.events)).toBe(true);
  });

  it("rss_trigger exposes rss_items from globals", () => {
    const result = executeRssTrigger(
      {},
      makeCtx({
        globals: {
          rss_items: [{ id: "g1", title: "t" }],
          feed_url: "https://x/feed"
        }
      })
    ) as Record<string, unknown>;
    expect(result.newItemCount).toBe(1);
    expect(result.feedUrl).toBe("https://x/feed");
  });

  it("sse_trigger exposes sse_event from globals", () => {
    const result = executeSseTrigger(
      {},
      makeCtx({
        globals: {
          sse_event: { event: "tick", id: "42", data: { n: 1 } },
          sse_url: "https://x/sse"
        }
      })
    ) as Record<string, unknown>;
    expect(result.eventName).toBe("tick");
    expect(result.eventId).toBe("42");
  });

  it("mcp_server_trigger flattens arguments into top-level keys", () => {
    const result = executeMcpServerTrigger(
      { toolName: "lookup" },
      makeCtx({
        webhookPayload: {
          call_id: "c1",
          arguments: { question: "What is up?", limit: 3 }
        }
      })
    ) as Record<string, unknown>;
    expect(result.toolName).toBe("lookup");
    expect(result.callId).toBe("c1");
    expect(result.question).toBe("What is up?");
    expect(result.limit).toBe(3);
  });

  it("mq triggers throw NOT_IMPLEMENTED when no message is delivered", () => {
    for (const executor of [executeKafkaTrigger, executeRabbitmqTrigger, executeMqttTrigger]) {
      try {
        executor({}, makeCtx());
        expect.fail("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(WorkflowError);
        expect((err as WorkflowError).category).toBe(ErrorCategory.NOT_IMPLEMENTED);
      }
    }
  });

  it("mq triggers surface delivered mq_message via globals", () => {
    const result = executeKafkaTrigger(
      {},
      makeCtx({ globals: { mq_message: { value: "hello" }, mq_metadata: { topic: "t" } } })
    ) as Record<string, unknown>;
    expect(result.triggered).toBe(true);
    expect((result.message as Record<string, unknown>).value).toBe("hello");
    expect((result.metadata as Record<string, unknown>).topic).toBe("t");
  });
});

describe("phase 3.5 triggers — dispatch", () => {
  it("covers every trigger type in its node-type set", () => {
    const listed = Array.from(PHASE35_TRIGGER_NODE_TYPES).sort();
    expect(listed).toEqual(
      [
        "manual_trigger",
        "form_trigger",
        "chat_trigger",
        "file_trigger",
        "rss_trigger",
        "sse_trigger",
        "mcp_server_trigger",
        "kafka_trigger",
        "rabbitmq_trigger",
        "mqtt_trigger"
      ].sort()
    );
  });

  it("dispatches manual_trigger via executePhase35TriggerNode", () => {
    const out = executePhase35TriggerNode(
      {
        id: "n1",
        type: "manual_trigger",
        name: "Start",
        position: { x: 0, y: 0 },
        config: { label: "Run" }
      },
      { label: "Run" },
      makeCtx()
    ) as Record<string, unknown>;
    expect(out.triggered).toBe(true);
    expect(out.trigger_type).toBe("manual");
  });
});
