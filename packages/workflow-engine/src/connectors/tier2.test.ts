import { describe, expect, it, vi } from "vitest";
import { ErrorCategory, WorkflowError } from "@ai-orchestrator/shared";
import {
  executeAirtableCreateRecord,
  executeAirtableListRecords,
  executeAirtableUpdateRecord,
  executeAwsS3GetObject,
  executeAwsS3ListObjects,
  executeAwsS3PutObject,
  executeDiscordSendMessage,
  executeGoogleCalendarCreateEvent,
  executeGoogleCalendarListEvents,
  executeGoogleDriveTrigger,
  executeHubspotCreateContact,
  executeHubspotGetContact,
  executeJiraCreateIssue,
  executeJiraSearchIssues,
  executeNotionCreatePage,
  executeNotionQueryDatabase,
  executeSalesforceCreateRecord,
  executeSalesforceQuery,
  executeStripeCreateCharge,
  executeStripeCreateCustomer,
  executeTeamsSendMessage,
  executeTelegramSendMessage,
  executeTwilioSendSms,
  type Tier2Context
} from "./tier2";

function makeCtx(overrides: Partial<Tier2Context> = {}): Tier2Context {
  return {
    templateData: { user_prompt: "hi", result: "ok" },
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

function lastRequest(fetchMock: ReturnType<typeof vi.fn>): { url: string; init: RequestInit } {
  const call = fetchMock.mock.calls[fetchMock.mock.calls.length - 1];
  return { url: call[0] as string, init: call[1] as RequestInit };
}

// ---------------------------------------------------------------------------
// Microsoft Teams
// ---------------------------------------------------------------------------

describe("tier2 — teams_send_message", () => {
  it("posts a MessageCard with templated text", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    const result = (await executeTeamsSendMessage(
      {
        webhookUrl: "https://outlook.office.com/webhook/abc",
        text: "hi {{user_prompt}}",
        title: "Alert"
      },
      makeCtx({ fetchImpl: fetchMock })
    )) as { ok: boolean };
    expect(result.ok).toBe(true);
    const body = JSON.parse((lastRequest(fetchMock).init.body as string) ?? "{}");
    expect(body.text).toBe("hi hi");
    expect(body["@type"]).toBe("MessageCard");
  });

  it("errors when webhookUrl missing", async () => {
    await expect(
      executeTeamsSendMessage({ text: "hi" }, makeCtx({ resolveSecret: async () => undefined }))
    ).rejects.toBeInstanceOf(WorkflowError);
  });
});

// ---------------------------------------------------------------------------
// Notion
// ---------------------------------------------------------------------------

describe("tier2 — notion", () => {
  it("creates a page with title + markdown blocks", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ object: "page", id: "abc" }));
    const result = (await executeNotionCreatePage(
      {
        secretRef: { secretId: "notion" },
        databaseId: "db123",
        titleProperty: "Name",
        title: "Task from {{user_prompt}}",
        contentMarkdown: "# Header\nFirst paragraph"
      },
      makeCtx({ fetchImpl: fetchMock })
    )) as { id: string };
    expect(result.id).toBe("abc");
    const body = JSON.parse((lastRequest(fetchMock).init.body as string) ?? "{}");
    expect(body.parent.database_id).toBe("db123");
    expect(body.properties.Name.title[0].text.content).toBe("Task from hi");
    expect(body.children).toHaveLength(2);
    expect(body.children[0].type).toBe("heading_1");
  });

  it("queries database with page_size clamp", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ results: [] }));
    await executeNotionQueryDatabase(
      { secretRef: { secretId: "x" }, databaseId: "db", pageSize: 500 },
      makeCtx({ fetchImpl: fetchMock })
    );
    const body = JSON.parse((lastRequest(fetchMock).init.body as string) ?? "{}");
    expect(body.page_size).toBe(100);
  });
});

// ---------------------------------------------------------------------------
// Airtable
// ---------------------------------------------------------------------------

describe("tier2 — airtable", () => {
  it("creates a record from fields JSON", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "rec1" }));
    const result = (await executeAirtableCreateRecord(
      {
        secretRef: { secretId: "at" },
        baseId: "appX",
        table: "Leads",
        fieldsJson: '{"Name":"{{user_prompt}}"}',
        typecast: true
      },
      makeCtx({ fetchImpl: fetchMock })
    )) as { id: string };
    expect(result.id).toBe("rec1");
    const { url, init } = lastRequest(fetchMock);
    expect(url).toBe("https://api.airtable.com/v0/appX/Leads");
    const body = JSON.parse((init.body as string) ?? "{}");
    expect(body.fields.Name).toBe("hi");
    expect(body.typecast).toBe(true);
  });

  it("lists records with formula in query string", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ records: [] }));
    await executeAirtableListRecords(
      {
        secretRef: { secretId: "at" },
        baseId: "appX",
        table: "Leads",
        filterByFormula: "{Status}='Open'",
        maxRecords: 25
      },
      makeCtx({ fetchImpl: fetchMock })
    );
    const { url } = lastRequest(fetchMock);
    expect(url).toContain("filterByFormula=%7BStatus%7D%3D%27Open%27");
    expect(url).toContain("maxRecords=25");
  });

  it("patches a record by ID", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "rec1" }));
    await executeAirtableUpdateRecord(
      {
        secretRef: { secretId: "at" },
        baseId: "appX",
        table: "Leads",
        recordId: "rec1",
        fieldsJson: '{"Status":"Contacted"}'
      },
      makeCtx({ fetchImpl: fetchMock })
    );
    const { url, init } = lastRequest(fetchMock);
    expect(init.method).toBe("PATCH");
    expect(url).toBe("https://api.airtable.com/v0/appX/Leads/rec1");
  });
});

// ---------------------------------------------------------------------------
// Jira
// ---------------------------------------------------------------------------

describe("tier2 — jira", () => {
  it("creates an issue with basic auth", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "10001", key: "ENG-1" }));
    await executeJiraCreateIssue(
      {
        baseUrl: "https://acme.atlassian.net/",
        secretRef: { secretId: "jira" },
        email: "bot@acme.com",
        projectKey: "ENG",
        issueType: "Task",
        summary: "Summary from {{user_prompt}}",
        description: "body"
      },
      makeCtx({ fetchImpl: fetchMock })
    );
    const { url, init } = lastRequest(fetchMock);
    expect(url).toBe("https://acme.atlassian.net/rest/api/3/issue");
    const authHeader = (init.headers as Record<string, string>).authorization;
    expect(authHeader.startsWith("Basic ")).toBe(true);
    const body = JSON.parse((init.body as string) ?? "{}");
    expect(body.fields.summary).toBe("Summary from hi");
    expect(body.fields.project.key).toBe("ENG");
    expect(body.fields.description.type).toBe("doc");
  });

  it("runs a JQL search", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ issues: [] }));
    await executeJiraSearchIssues(
      {
        baseUrl: "https://acme.atlassian.net",
        secretRef: { secretId: "jira" },
        email: "bot@acme.com",
        jql: "project = ENG",
        maxResults: 10
      },
      makeCtx({ fetchImpl: fetchMock })
    );
    const body = JSON.parse((lastRequest(fetchMock).init.body as string) ?? "{}");
    expect(body.jql).toBe("project = ENG");
    expect(body.maxResults).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Salesforce
// ---------------------------------------------------------------------------

describe("tier2 — salesforce", () => {
  it("creates a record with bearer token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "001xx" }));
    await executeSalesforceCreateRecord(
      {
        instanceUrl: "https://acme.my.salesforce.com/",
        apiVersion: "v59.0",
        secretRef: { secretId: "sf" },
        sobject: "Lead",
        fieldsJson: '{"LastName":"Smith","Company":"Acme"}'
      },
      makeCtx({ fetchImpl: fetchMock })
    );
    const { url, init } = lastRequest(fetchMock);
    expect(url).toBe("https://acme.my.salesforce.com/services/data/v59.0/sobjects/Lead");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer secret-token");
  });

  it("runs a SOQL query via GET", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ records: [] }));
    await executeSalesforceQuery(
      {
        instanceUrl: "https://acme.my.salesforce.com",
        secretRef: { secretId: "sf" },
        soql: "SELECT Id FROM Account"
      },
      makeCtx({ fetchImpl: fetchMock })
    );
    const { url, init } = lastRequest(fetchMock);
    expect(init.method).toBe("GET");
    expect(url).toContain("SELECT%20Id%20FROM%20Account");
  });
});

// ---------------------------------------------------------------------------
// HubSpot
// ---------------------------------------------------------------------------

describe("tier2 — hubspot", () => {
  it("creates a contact with templated properties", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "c1" }));
    await executeHubspotCreateContact(
      {
        secretRef: { secretId: "hs" },
        propertiesJson: '{"email":"{{user_prompt}}"}'
      },
      makeCtx({ fetchImpl: fetchMock })
    );
    const body = JSON.parse((lastRequest(fetchMock).init.body as string) ?? "{}");
    expect(body.properties.email).toBe("hi");
  });

  it("gets a contact by email (idProperty=email)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "c1" }));
    await executeHubspotGetContact(
      { secretRef: { secretId: "hs" }, identifier: "someone@x.com", idProperty: "email" },
      makeCtx({ fetchImpl: fetchMock })
    );
    expect(lastRequest(fetchMock).url).toBe(
      "https://api.hubapi.com/crm/v3/objects/contacts/someone%40x.com?idProperty=email"
    );
  });
});

// ---------------------------------------------------------------------------
// Stripe
// ---------------------------------------------------------------------------

describe("tier2 — stripe", () => {
  it("creates a customer with form-encoded body", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "cus_1" }));
    await executeStripeCreateCustomer(
      {
        secretRef: { secretId: "sk" },
        email: "alice@x.com",
        name: "Alice",
        metadataJson: '{"plan":"gold"}'
      },
      makeCtx({ fetchImpl: fetchMock })
    );
    const { url, init } = lastRequest(fetchMock);
    expect(url).toBe("https://api.stripe.com/v1/customers");
    expect((init.headers as Record<string, string>)["content-type"]).toBe(
      "application/x-www-form-urlencoded"
    );
    const body = init.body as string;
    expect(body).toContain("email=alice%40x.com");
    expect(body).toContain("name=Alice");
    expect(body).toContain("metadata%5Bplan%5D=gold");
  });

  it("creates a PaymentIntent", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "pi_1", status: "requires_payment_method" }));
    const result = (await executeStripeCreateCharge(
      {
        secretRef: { secretId: "sk" },
        amount: 1999,
        currency: "usd",
        description: "Test charge"
      },
      makeCtx({ fetchImpl: fetchMock })
    )) as { id: string };
    expect(result.id).toBe("pi_1");
    const body = lastRequest(fetchMock).init.body as string;
    expect(body).toContain("amount=1999");
    expect(body).toContain("currency=usd");
  });

  it("rejects zero amount", async () => {
    await expect(
      executeStripeCreateCharge(
        { secretRef: { secretId: "sk" }, amount: 0, currency: "usd" },
        makeCtx({ fetchImpl: vi.fn() })
      )
    ).rejects.toBeInstanceOf(WorkflowError);
  });
});

// ---------------------------------------------------------------------------
// AWS S3 (SigV4 hand-rolled)
// ---------------------------------------------------------------------------

describe("tier2 — aws_s3", () => {
  const credentials = JSON.stringify({
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"
  });
  const fixedNow = () => Date.parse("2026-04-15T00:00:00Z");

  it("signs a PutObject request with SigV4", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 200, headers: { etag: '"abc"' } }));
    const result = (await executeAwsS3PutObject(
      {
        region: "us-east-1",
        bucket: "my-bucket",
        key: "path/{{result}}.txt",
        body: "hello",
        contentType: "text/plain",
        secretRef: { secretId: "aws" }
      },
      makeCtx({ fetchImpl: fetchMock, resolveSecret: async () => credentials, nowMs: fixedNow })
    )) as { ok: boolean; key: string };
    expect(result.ok).toBe(true);
    expect(result.key).toBe("path/ok.txt");
    const { url, init } = lastRequest(fetchMock);
    expect(url).toBe("https://my-bucket.s3.us-east-1.amazonaws.com/path/ok.txt");
    expect(init.method).toBe("PUT");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/20260415\/us-east-1\/s3\/aws4_request, SignedHeaders=[\w;-]+, Signature=[0-9a-f]{64}$/
    );
    expect(headers["x-amz-date"]).toBe("20260415T000000Z");
  });

  it("lists objects and parses XML contents", async () => {
    const xml = `<?xml version="1.0"?><ListBucketResult>
      <Contents><Key>a.txt</Key><Size>5</Size><LastModified>2026-04-10T00:00:00.000Z</LastModified></Contents>
      <Contents><Key>b.txt</Key><Size>9</Size><LastModified>2026-04-12T00:00:00.000Z</LastModified></Contents>
      <IsTruncated>false</IsTruncated>
    </ListBucketResult>`;
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(xml, { status: 200, headers: { "content-type": "application/xml" } })
    );
    const result = (await executeAwsS3ListObjects(
      { region: "us-east-1", bucket: "my-bucket", prefix: "foo/", secretRef: { secretId: "aws" } },
      makeCtx({ fetchImpl: fetchMock, resolveSecret: async () => credentials, nowMs: fixedNow })
    )) as { items: Array<{ key: string; size: number }>; truncated: boolean };
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toEqual(
      expect.objectContaining({ key: "a.txt", size: 5 })
    );
    expect(result.truncated).toBe(false);
  });

  it("returns base64 body for non-text GetObject", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(Buffer.from([0, 1, 2, 3]), {
        status: 200,
        headers: { "content-type": "application/octet-stream" }
      })
    );
    const result = (await executeAwsS3GetObject(
      { region: "us-east-1", bucket: "my-bucket", key: "bin", secretRef: { secretId: "aws" } },
      makeCtx({ fetchImpl: fetchMock, resolveSecret: async () => credentials, nowMs: fixedNow })
    )) as { encoding: string; body: string };
    expect(result.encoding).toBe("base64");
    expect(Buffer.from(result.body, "base64")).toEqual(Buffer.from([0, 1, 2, 3]));
  });

  it("rejects missing credentials", async () => {
    await expect(
      executeAwsS3PutObject(
        { region: "us-east-1", bucket: "x", key: "k", body: "a" },
        makeCtx({ resolveSecret: async () => undefined })
      )
    ).rejects.toBeInstanceOf(WorkflowError);
  });
});

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

describe("tier2 — telegram", () => {
  it("calls the Bot API sendMessage", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true, result: { message_id: 1 } }));
    await executeTelegramSendMessage(
      {
        secretRef: { secretId: "tg" },
        chatId: "@channel",
        text: "hello {{user_prompt}}",
        parseMode: "Markdown"
      },
      makeCtx({ fetchImpl: fetchMock })
    );
    const { url, init } = lastRequest(fetchMock);
    expect(url).toBe("https://api.telegram.org/botsecret-token/sendMessage");
    const body = JSON.parse((init.body as string) ?? "{}");
    expect(body.chat_id).toBe("@channel");
    expect(body.text).toBe("hello hi");
    expect(body.parse_mode).toBe("Markdown");
  });
});

// ---------------------------------------------------------------------------
// Discord
// ---------------------------------------------------------------------------

describe("tier2 — discord", () => {
  it("posts to a webhook URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("", { status: 200 }));
    const result = (await executeDiscordSendMessage(
      {
        webhookUrl: "https://discord.com/api/webhooks/x/y",
        content: "alert {{user_prompt}}",
        username: "bot"
      },
      makeCtx({ fetchImpl: fetchMock, resolveSecret: async () => undefined })
    )) as { ok: boolean };
    expect(result.ok).toBe(true);
    const body = JSON.parse((lastRequest(fetchMock).init.body as string) ?? "{}");
    expect(body.content).toBe("alert hi");
    expect(body.username).toBe("bot");
  });

  it("requires webhookUrl or secretRef", async () => {
    await expect(
      executeDiscordSendMessage(
        { content: "x" },
        makeCtx({ fetchImpl: vi.fn(), resolveSecret: async () => undefined })
      )
    ).rejects.toBeInstanceOf(WorkflowError);
  });
});

// ---------------------------------------------------------------------------
// Google Drive / Calendar
// ---------------------------------------------------------------------------

describe("tier2 — google drive trigger", () => {
  it("polls the drive folder", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ files: [] }));
    await executeGoogleDriveTrigger(
      { secretRef: { secretId: "gd" }, folderId: "abc123" },
      makeCtx({ fetchImpl: fetchMock })
    );
    const { url } = lastRequest(fetchMock);
    expect(url).toContain("https://www.googleapis.com/drive/v3/files");
    expect(url).toContain("%27abc123%27+in+parents");
  });
});

describe("tier2 — google calendar", () => {
  it("creates an event with attendees", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "ev1" }));
    await executeGoogleCalendarCreateEvent(
      {
        secretRef: { secretId: "gcal" },
        calendarId: "primary",
        summary: "Meeting {{user_prompt}}",
        start: "2026-05-01T10:00:00",
        end: "2026-05-01T11:00:00",
        timeZone: "UTC",
        attendeesCsv: "a@x.com, b@x.com"
      },
      makeCtx({ fetchImpl: fetchMock })
    );
    const body = JSON.parse((lastRequest(fetchMock).init.body as string) ?? "{}");
    expect(body.summary).toBe("Meeting hi");
    expect(body.attendees).toHaveLength(2);
    expect(body.attendees[0].email).toBe("a@x.com");
  });

  it("lists events with orderBy=startTime and singleEvents=true", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ items: [] }));
    await executeGoogleCalendarListEvents(
      { secretRef: { secretId: "gcal" }, calendarId: "primary", maxResults: 5 },
      makeCtx({ fetchImpl: fetchMock })
    );
    const { url } = lastRequest(fetchMock);
    expect(url).toContain("orderBy=startTime");
    expect(url).toContain("singleEvents=true");
    expect(url).toContain("maxResults=5");
  });
});

// ---------------------------------------------------------------------------
// Twilio
// ---------------------------------------------------------------------------

describe("tier2 — twilio", () => {
  it("posts form-encoded SMS with basic auth", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ sid: "SM1", status: "queued" }));
    await executeTwilioSendSms(
      {
        accountSid: "AC123",
        secretRef: { secretId: "tw" },
        from: "+15551234567",
        to: "+15557654321",
        body: "hi {{user_prompt}}"
      },
      makeCtx({ fetchImpl: fetchMock })
    );
    const { url, init } = lastRequest(fetchMock);
    expect(url).toBe("https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json");
    const auth = (init.headers as Record<string, string>).authorization;
    expect(auth.startsWith("Basic ")).toBe(true);
    const decoded = Buffer.from(auth.slice(6), "base64").toString("utf8");
    expect(decoded).toBe("AC123:secret-token");
    expect(init.body).toContain("Body=hi+hi");
  });
});

// ---------------------------------------------------------------------------
// Error classification
// ---------------------------------------------------------------------------

describe("tier2 — HTTP error classification", () => {
  it("401 is PROVIDER_AUTH (non-retryable)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("nope", { status: 401 }));
    try {
      await executeAirtableListRecords(
        { secretRef: { secretId: "at" }, baseId: "x", table: "y" },
        makeCtx({ fetchImpl: fetchMock })
      );
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowError);
      expect((err as WorkflowError).category).toBe(ErrorCategory.PROVIDER_AUTH);
      expect((err as WorkflowError).retryable).toBe(false);
    }
  });

  it("429 is PROVIDER_QUOTA (retryable)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("slow", { status: 429 }));
    try {
      await executeNotionQueryDatabase(
        { secretRef: { secretId: "n" }, databaseId: "d" },
        makeCtx({ fetchImpl: fetchMock })
      );
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowError);
      expect((err as WorkflowError).category).toBe(ErrorCategory.PROVIDER_QUOTA);
      expect((err as WorkflowError).retryable).toBe(true);
    }
  });

  it("500 is CONNECTOR_TRANSIENT (retryable)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("boom", { status: 503 }));
    try {
      await executeStripeCreateCustomer(
        { secretRef: { secretId: "sk" }, email: "x@x.com" },
        makeCtx({ fetchImpl: fetchMock })
      );
      expect.fail("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(WorkflowError);
      expect((err as WorkflowError).category).toBe(ErrorCategory.CONNECTOR_TRANSIENT);
      expect((err as WorkflowError).retryable).toBe(true);
    }
  });
});
