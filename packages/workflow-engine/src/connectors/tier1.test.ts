import { describe, expect, it, vi } from "vitest";
import { ErrorCategory, WorkflowError } from "@ai-orchestrator/shared";
import {
  executeGitHubAction,
  executeGoogleSheetsAppend,
  executeGoogleSheetsRead,
  executeImapEmailTrigger,
  executeMongoOperation,
  executeMysqlQuery,
  executePostgresQuery,
  executeRedisCommand,
  executeSlackSendMessage,
  executeSmtpSendEmail,
  type Tier1Context
} from "./tier1";

function makeCtx(overrides: Partial<Tier1Context> = {}): Tier1Context {
  return {
    templateData: { user_prompt: "hi" },
    resolveSecret: async () => "secret-token",
    ...overrides
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

describe("tier1 — slack_send_message", () => {
  it("posts to incoming webhook", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    const result = (await executeSlackSendMessage(
      {
        authType: "webhook",
        webhookUrl: "https://hooks.slack.com/services/T/B/xyz",
        text: "hello {{user_prompt}}"
      },
      makeCtx({ fetchImpl: fetchMock })
    )) as { ok: boolean };
    expect(result.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.text).toBe("hello hi");
  });

  it("errors when bot token missing channel", async () => {
    const fetchMock = vi.fn();
    await expect(
      executeSlackSendMessage(
        { authType: "bot", text: "x" },
        makeCtx({ fetchImpl: fetchMock })
      )
    ).rejects.toBeInstanceOf(WorkflowError);
  });

  it("propagates Slack API error as auth category", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ ok: false, error: "invalid_auth" }, 401));
    try {
      await executeSlackSendMessage(
        {
          authType: "bot",
          channel: "#x",
          text: "hi",
          secretRef: { secretId: "slack-bot" }
        },
        makeCtx({ fetchImpl: fetchMock })
      );
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowError);
      expect((err as WorkflowError).category).toBe(ErrorCategory.PROVIDER_AUTH);
    }
  });
});

describe("tier1 — smtp_send_email", () => {
  it("sends via injected transport", async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: "<abc>" });
    const close = vi.fn();
    const ctx = makeCtx({
      clients: {
        createNodemailerTransport: () => ({ sendMail, close })
      }
    });
    const res = (await executeSmtpSendEmail(
      {
        host: "smtp.example.com",
        port: 587,
        user: "u@x.com",
        from: "u@x.com",
        to: "v@x.com",
        subject: "hi {{user_prompt}}",
        text: "body"
      },
      ctx
    )) as { ok: boolean };
    expect(res.ok).toBe(true);
    expect(sendMail).toHaveBeenCalledOnce();
    expect(sendMail.mock.calls[0]![0]).toMatchObject({ subject: "hi hi" });
    expect(close).toHaveBeenCalled();
  });

  it("throws nodeConfig when required fields missing", async () => {
    await expect(
      executeSmtpSendEmail({ host: "x" }, makeCtx())
    ).rejects.toBeInstanceOf(WorkflowError);
  });
});

describe("tier1 — imap_email_trigger", () => {
  it("throws NOT_IMPLEMENTED when imapflow absent", async () => {
    try {
      await executeImapEmailTrigger({ host: "x", port: 993, user: "u" }, makeCtx());
      expect.fail("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowError);
      expect([ErrorCategory.NOT_IMPLEMENTED]).toContain((err as WorkflowError).category);
    }
  });
});

describe("tier1 — google_sheets", () => {
  it("reads values from API", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ range: "Sheet1!A1:B2", values: [["a", "b"]] })
    );
    const res = (await executeGoogleSheetsRead(
      {
        spreadsheetId: "sheet",
        range: "Sheet1!A1:B2",
        authType: "accessToken",
        secretRef: { secretId: "oauth" }
      },
      makeCtx({ fetchImpl: fetchMock })
    )) as { values: unknown };
    expect(res.values).toEqual([["a", "b"]]);
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain("/spreadsheets/sheet/values/Sheet1!A1%3AB2");
  });

  it("appends values with valueInputOption", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ updates: { updatedRows: 1 } }));
    await executeGoogleSheetsAppend(
      {
        spreadsheetId: "sheet",
        range: "Sheet1!A1",
        values: [["x", "y"]],
        valueInputOption: "RAW",
        authType: "accessToken",
        secretRef: { secretId: "oauth" }
      },
      makeCtx({ fetchImpl: fetchMock })
    );
    const url = fetchMock.mock.calls[0]![0] as string;
    expect(url).toContain("valueInputOption=RAW");
    expect(url).toContain(":append");
  });

  it("errors on 403", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ error: "forbidden" }, 403));
    await expect(
      executeGoogleSheetsRead(
        {
          spreadsheetId: "s",
          range: "A1:B2",
          authType: "apiKey",
          secretRef: { secretId: "k" }
        },
        makeCtx({ fetchImpl: fetchMock })
      )
    ).rejects.toBeInstanceOf(WorkflowError);
  });
});

describe("tier1 — postgres_query", () => {
  it("runs the query via injected client", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ id: 1 }], rowCount: 1 });
    const end = vi.fn().mockResolvedValue(undefined);
    const connect = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx({
      clients: {
        createPgClient: () => ({ connect, query, end })
      }
    });
    const res = (await executePostgresQuery(
      {
        host: "h",
        database: "d",
        user: "u",
        query: "SELECT 1",
        secretRef: { secretId: "pw" }
      },
      ctx
    )) as { rowCount: number };
    expect(res.rowCount).toBe(1);
    expect(end).toHaveBeenCalled();
  });

  it("wraps client errors in WorkflowError", async () => {
    const client = {
      connect: async () => undefined,
      query: async () => {
        throw new Error("boom");
      },
      end: async () => undefined
    };
    const ctx = makeCtx({
      clients: { createPgClient: () => client }
    });
    await expect(
      executePostgresQuery(
        { host: "h", database: "d", user: "u", query: "X" },
        ctx
      )
    ).rejects.toBeInstanceOf(WorkflowError);
  });
});

describe("tier1 — mysql_query", () => {
  it("executes and returns rows", async () => {
    const execute = vi.fn().mockResolvedValue([[{ a: 1 }], []]);
    const end = vi.fn().mockResolvedValue(undefined);
    const ctx = makeCtx({
      clients: {
        createMysqlConnection: async () => ({ execute, end })
      }
    });
    const res = (await executeMysqlQuery(
      { host: "h", database: "d", user: "u", query: "SELECT ?", params: [1] },
      ctx
    )) as { rowCount: number };
    expect(res.rowCount).toBe(1);
    expect(end).toHaveBeenCalled();
  });

  it("errors on missing host", async () => {
    await expect(
      executeMysqlQuery({ database: "d", user: "u", query: "x" }, makeCtx())
    ).rejects.toBeInstanceOf(WorkflowError);
  });
});

describe("tier1 — mongo_operation", () => {
  function mockMongo(opts: { findDocs?: unknown[]; insertOneResult?: unknown } = {}) {
    const col = {
      find: vi.fn().mockReturnValue({ toArray: async () => opts.findDocs ?? [] }),
      insertOne: vi.fn().mockResolvedValue(opts.insertOneResult ?? { insertedId: "id1" }),
      insertMany: vi.fn().mockResolvedValue({}),
      updateOne: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({}),
      aggregate: vi.fn().mockReturnValue({ toArray: async () => [] })
    };
    const client = {
      connect: vi.fn().mockResolvedValue(undefined),
      db: () => ({ collection: () => col }),
      close: vi.fn().mockResolvedValue(undefined)
    };
    return { client, col };
  }

  it("performs find", async () => {
    const { client } = mockMongo({ findDocs: [{ x: 1 }] });
    const ctx = makeCtx({
      clients: { createMongoClient: () => client }
    });
    const res = (await executeMongoOperation(
      {
        uri: "mongodb://localhost",
        database: "app",
        collection: "users",
        operation: "find",
        query: { active: true }
      },
      ctx
    )) as { docs: unknown[] };
    expect(res.docs).toEqual([{ x: 1 }]);
    expect(client.close).toHaveBeenCalled();
  });

  it("errors on unknown operation", async () => {
    const { client } = mockMongo();
    const ctx = makeCtx({
      clients: { createMongoClient: () => client }
    });
    await expect(
      executeMongoOperation(
        {
          uri: "mongodb://localhost",
          database: "app",
          collection: "users",
          operation: "nope"
        },
        ctx
      )
    ).rejects.toBeInstanceOf(WorkflowError);
  });
});

describe("tier1 — redis_command", () => {
  it("calls command with args", async () => {
    const call = vi.fn().mockResolvedValue("OK");
    const quit = vi.fn().mockResolvedValue("OK");
    const ctx = makeCtx({
      clients: {
        createRedisClient: () => ({ call, quit })
      }
    });
    const res = (await executeRedisCommand(
      { command: "SET", args: ["k", "{{user_prompt}}"] },
      ctx
    )) as { result: string };
    expect(res.result).toBe("OK");
    expect(call).toHaveBeenCalledWith("SET", "k", "hi");
    expect(quit).toHaveBeenCalled();
  });

  it("wraps redis errors", async () => {
    const ctx = makeCtx({
      clients: {
        createRedisClient: () => ({
          call: async () => {
            throw new Error("ECONNREFUSED");
          },
          quit: async () => undefined
        })
      }
    });
    await expect(
      executeRedisCommand({ command: "GET", args: ["k"] }, ctx)
    ).rejects.toBeInstanceOf(WorkflowError);
  });
});

describe("tier1 — github_action", () => {
  it("creates an issue", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ number: 7, title: "Hello" }), { status: 201 })
    );
    const res = (await executeGitHubAction(
      {
        owner: "o",
        repo: "r",
        operation: "createIssue",
        title: "Hello",
        body: "body",
        secretRef: { secretId: "gh" }
      },
      makeCtx({ fetchImpl: fetchMock })
    )) as { number: number };
    expect(res.number).toBe(7);
    const call = fetchMock.mock.calls[0]!;
    expect(call[0]).toBe("https://api.github.com/repos/o/r/issues");
    expect((call[1] as RequestInit).method).toBe("POST");
  });

  it("errors on 404 without retrying", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }));
    try {
      await executeGitHubAction(
        {
          owner: "o",
          repo: "r",
          operation: "getFile",
          path: "README.md",
          secretRef: { secretId: "gh" }
        },
        makeCtx({ fetchImpl: fetchMock })
      );
      expect.fail("should throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowError);
      expect((err as WorkflowError).retryable).toBe(false);
    }
  });
});
