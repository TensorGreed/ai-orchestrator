import { createSign } from "node:crypto";
import type { SecretReference } from "@ai-orchestrator/shared";
import type { ConnectorAdapter, ConnectorExecutionContext } from "../types";

const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_DRIVE_API_BASE_URL = "https://www.googleapis.com/drive/v3";
const GOOGLE_DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.readonly";

type GoogleServiceAccountCredential = {
  type?: string;
  client_email?: string;
  private_key?: string;
  token_uri?: string;
  subject?: string;
};

type GoogleDriveFile = {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime?: string;
  webViewLink?: string;
  description?: string;
};

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => String(item).trim()).filter(Boolean);
}

function toBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function toPositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const parsed = Math.floor(value);
  return parsed > 0 ? parsed : fallback;
}

function base64Url(input: string | Buffer): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function buildServiceAccountJwt(input: { clientEmail: string; privateKey: string; scope: string; subject?: string }): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const payload: Record<string, unknown> = {
    iss: input.clientEmail,
    scope: input.scope,
    aud: GOOGLE_OAUTH_TOKEN_URL,
    iat: now,
    exp: now + 3600
  };
  if (input.subject && input.subject.trim()) {
    payload.sub = input.subject.trim();
  }

  const encodedHeader = base64Url(JSON.stringify(header));
  const encodedPayload = base64Url(JSON.stringify(payload));
  const unsigned = `${encodedHeader}.${encodedPayload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(input.privateKey);
  return `${unsigned}.${base64Url(signature)}`;
}

async function exchangeServiceAccountToken(credential: GoogleServiceAccountCredential): Promise<string> {
  const clientEmail = typeof credential.client_email === "string" ? credential.client_email.trim() : "";
  const privateKey = typeof credential.private_key === "string" ? credential.private_key : "";
  if (!clientEmail || !privateKey) {
    throw new Error("Google Drive service account credential must include client_email and private_key.");
  }

  const assertion = buildServiceAccountJwt({
    clientEmail,
    privateKey,
    scope: GOOGLE_DRIVE_SCOPE,
    subject: typeof credential.subject === "string" ? credential.subject : undefined
  });

  const tokenUrl =
    typeof credential.token_uri === "string" && credential.token_uri.trim()
      ? credential.token_uri.trim()
      : GOOGLE_OAUTH_TOKEN_URL;

  const response = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    })
  });

  const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  if (!response.ok) {
    const detail = payload && typeof payload.error_description === "string" ? payload.error_description : response.statusText;
    throw new Error(`Google OAuth token exchange failed (${response.status}): ${detail || "Unknown error"}`);
  }

  const accessToken = payload && typeof payload.access_token === "string" ? payload.access_token.trim() : "";
  if (!accessToken) {
    throw new Error("Google OAuth token exchange succeeded but no access_token was returned.");
  }

  return accessToken;
}

function parseGoogleCredential(secretValue: string): { accessToken?: string; serviceAccount?: GoogleServiceAccountCredential } {
  const trimmed = secretValue.trim();
  if (!trimmed) {
    return {};
  }

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const accessTokenCandidates = ["access_token", "accessToken", "oauth_access_token", "token"];
    for (const key of accessTokenCandidates) {
      const value = parsed[key];
      if (typeof value === "string" && value.trim()) {
        return { accessToken: value.trim() };
      }
    }

    if (parsed.type === "service_account" || (typeof parsed.client_email === "string" && typeof parsed.private_key === "string")) {
      return { serviceAccount: parsed as GoogleServiceAccountCredential };
    }
  } catch {
    return { accessToken: trimmed };
  }

  return {};
}

function shouldTreatAsTextMimeType(mimeType: string): boolean {
  if (!mimeType) {
    return false;
  }
  if (mimeType.startsWith("text/")) {
    return true;
  }
  return (
    mimeType === "application/json" ||
    mimeType === "application/xml" ||
    mimeType === "application/javascript" ||
    mimeType === "application/x-ndjson" ||
    mimeType === "application/csv"
  );
}

function googleExportMimeType(mimeType: string): string | null {
  if (mimeType === "application/vnd.google-apps.document") {
    return "text/plain";
  }
  if (mimeType === "application/vnd.google-apps.spreadsheet") {
    return "text/csv";
  }
  if (mimeType === "application/vnd.google-apps.presentation") {
    return "text/plain";
  }
  return null;
}

async function readJsonResponse<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

function createDemoDocuments(config: Record<string, unknown>) {
  const staticDocs = toStringArray(config.staticDocuments);
  const demoDocs = [
    "Model Context Protocol (MCP) is used to connect tools and resources to agent workflows.",
    "Ollama provides local model execution and OpenAI-compatible APIs.",
    "RAG improves response quality by grounding prompts in retrieved documents."
  ];

  const allDocs = [...demoDocs, ...staticDocs];
  return allDocs.map((text, index) => ({
    id: `gdrive-demo-${index + 1}`,
    text,
    metadata: {
      source: "google-drive",
      mode: "demo-fallback",
      folderId: typeof config.folderId === "string" ? config.folderId : "sample"
    }
  }));
}

function encodeDriveQueryValue(value: string): string {
  return value.replace(/'/g, "\\'");
}

function buildDriveListQuery(config: Record<string, unknown>): string {
  const parts = ["trashed = false"];
  const folderId = typeof config.folderId === "string" ? config.folderId.trim() : "";
  if (folderId) {
    parts.push(`'${encodeDriveQueryValue(folderId)}' in parents`);
  }
  const customQuery = typeof config.query === "string" ? config.query.trim() : "";
  if (customQuery) {
    parts.push(`(${customQuery})`);
  }
  return parts.join(" and ");
}

function buildDriveHeaders(accessToken: string): Record<string, string> {
  return {
    authorization: `Bearer ${accessToken}`
  };
}

async function resolveAccessToken(config: Record<string, unknown>, context: ConnectorExecutionContext): Promise<string | undefined> {
  const secretRefRecord = toRecord(config.secretRef);
  const secretId = typeof secretRefRecord.secretId === "string" ? secretRefRecord.secretId.trim() : "";
  const secretRef: SecretReference | undefined = secretId ? { secretId } : undefined;
  const secretValue = await context.resolveSecret(secretRef);
  if (!secretValue || !secretValue.trim()) {
    return undefined;
  }

  const parsedCredential = parseGoogleCredential(secretValue);
  if (parsedCredential.accessToken) {
    return parsedCredential.accessToken;
  }
  if (parsedCredential.serviceAccount) {
    return exchangeServiceAccountToken(parsedCredential.serviceAccount);
  }
  return undefined;
}

export class GoogleDriveConnectorAdapter implements ConnectorAdapter {
  readonly definition = {
    id: "google-drive",
    label: "Google Drive",
    category: "google_drive" as const,
    description: "Fetches text documents from Google Drive for RAG context.",
    configSchema: {
      type: "object",
      properties: {
        folderId: { type: "string" },
        fileIds: { type: "array", items: { type: "string" } },
        query: { type: "string" },
        maxFiles: { type: "number" },
        includeSharedDrives: { type: "boolean" },
        includeNativeGoogleDocs: { type: "boolean" },
        useDemoFallback: { type: "boolean" },
        staticDocuments: { type: "array", items: { type: "string" } }
      }
    },
    authSchema: {
      type: "object",
      properties: {
        secretRef: { type: "object", properties: { secretId: { type: "string" } } }
      }
    }
  };

  async testConnection(config: Record<string, unknown>, context: ConnectorExecutionContext) {
    const useDemoFallback = toBoolean(config.useDemoFallback, true);
    try {
      const accessToken = await resolveAccessToken(config, context);
      if (!accessToken) {
        return {
          ok: useDemoFallback,
          message: useDemoFallback
            ? "No Google Drive credential provided. Connector will use demo fallback documents."
            : "No Google Drive credential provided."
        };
      }

      const response = await fetch(`${GOOGLE_DRIVE_API_BASE_URL}/about?fields=user(displayName)`, {
        method: "GET",
        headers: buildDriveHeaders(accessToken)
      });
      if (!response.ok) {
        const body = await response.text();
        return {
          ok: false,
          message: `Google Drive auth failed (${response.status}): ${body.slice(0, 240)}`
        };
      }

      const payload = (await readJsonResponse<{ user?: { displayName?: string } }>(response)) ?? {};
      const displayName = payload.user?.displayName ?? "Google account";
      return {
        ok: true,
        message: `Connected to Google Drive as ${displayName}.`
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : "Google Drive connection failed."
      };
    }
  }

  async fetchData(config: Record<string, unknown>, context: ConnectorExecutionContext) {
    const useDemoFallback = toBoolean(config.useDemoFallback, true);
    const includeNativeGoogleDocs = toBoolean(config.includeNativeGoogleDocs, true);
    const includeSharedDrives = toBoolean(config.includeSharedDrives, true);
    const maxFiles = Math.max(1, Math.min(100, toPositiveInt(config.maxFiles, 10)));
    const baseUrl =
      typeof config.baseUrl === "string" && config.baseUrl.trim() ? config.baseUrl.trim().replace(/\/+$/, "") : GOOGLE_DRIVE_API_BASE_URL;

    const token = await resolveAccessToken(config, context);
    if (!token) {
      if (useDemoFallback) {
        return {
          documents: createDemoDocuments(config),
          raw: { mode: "demo-fallback", reason: "missing_credentials" }
        };
      }
      return {
        documents: [],
        raw: { mode: "empty", reason: "missing_credentials" }
      };
    }

    const fileIds = [
      ...toStringArray(config.fileIds),
      ...toStringArray(typeof config.fileIdsCsv === "string" ? config.fileIdsCsv.split(/[,\n]/g) : [])
    ];

    const files: GoogleDriveFile[] = [];
    if (fileIds.length > 0) {
      for (const fileId of fileIds.slice(0, maxFiles)) {
        const response = await fetch(
          `${baseUrl}/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,modifiedTime,webViewLink,description`,
          {
            method: "GET",
            headers: buildDriveHeaders(token)
          }
        );
        if (!response.ok) {
          continue;
        }
        const payload = (await readJsonResponse<GoogleDriveFile>(response)) ?? null;
        if (payload?.id && payload.name && payload.mimeType) {
          files.push(payload);
        }
      }
    } else {
      const listParams = new URLSearchParams({
        q: buildDriveListQuery(config),
        pageSize: String(maxFiles),
        fields: "files(id,name,mimeType,modifiedTime,webViewLink,description)",
        orderBy: "modifiedTime desc"
      });
      if (includeSharedDrives) {
        listParams.set("includeItemsFromAllDrives", "true");
        listParams.set("supportsAllDrives", "true");
      }
      const listResponse = await fetch(`${baseUrl}/files?${listParams.toString()}`, {
        method: "GET",
        headers: buildDriveHeaders(token)
      });

      if (!listResponse.ok) {
        const detail = (await listResponse.text()).slice(0, 320);
        if (useDemoFallback) {
          return {
            documents: createDemoDocuments(config),
            raw: { mode: "demo-fallback", reason: "drive_list_failed", status: listResponse.status, detail }
          };
        }
        throw new Error(`Google Drive file listing failed (${listResponse.status}): ${detail}`);
      }

      const listPayload = (await readJsonResponse<{ files?: GoogleDriveFile[] }>(listResponse)) ?? {};
      files.push(...(Array.isArray(listPayload.files) ? listPayload.files : []));
    }

    const documents: Array<{ id: string; text: string; metadata: Record<string, unknown> }> = [];
    const skipped: Array<{ fileId: string; reason: string }> = [];

    for (const file of files.slice(0, maxFiles)) {
      try {
        let textPayload: string | null = null;
        if (file.mimeType.startsWith("application/vnd.google-apps.")) {
          if (!includeNativeGoogleDocs) {
            skipped.push({ fileId: file.id, reason: "native_docs_disabled" });
            continue;
          }
          const exportMimeType = googleExportMimeType(file.mimeType);
          if (!exportMimeType) {
            skipped.push({ fileId: file.id, reason: `unsupported_native_mime:${file.mimeType}` });
            continue;
          }
          const exportResponse = await fetch(
            `${baseUrl}/files/${encodeURIComponent(file.id)}/export?mimeType=${encodeURIComponent(exportMimeType)}`,
            {
              method: "GET",
              headers: buildDriveHeaders(token)
            }
          );
          if (!exportResponse.ok) {
            skipped.push({ fileId: file.id, reason: `export_failed:${exportResponse.status}` });
            continue;
          }
          textPayload = (await exportResponse.text()).trim();
        } else {
          if (!shouldTreatAsTextMimeType(file.mimeType)) {
            skipped.push({ fileId: file.id, reason: `non_text_mime:${file.mimeType}` });
            continue;
          }
          const downloadResponse = await fetch(`${baseUrl}/files/${encodeURIComponent(file.id)}?alt=media`, {
            method: "GET",
            headers: buildDriveHeaders(token)
          });
          if (!downloadResponse.ok) {
            skipped.push({ fileId: file.id, reason: `download_failed:${downloadResponse.status}` });
            continue;
          }
          textPayload = (await downloadResponse.text()).trim();
        }

        if (!textPayload) {
          skipped.push({ fileId: file.id, reason: "empty_text" });
          continue;
        }

        documents.push({
          id: `gdrive-${file.id}`,
          text: textPayload,
          metadata: {
            source: "google-drive",
            fileId: file.id,
            name: file.name,
            mimeType: file.mimeType,
            modifiedTime: file.modifiedTime ?? null,
            webViewLink: file.webViewLink ?? null,
            description: file.description ?? null
          }
        });
      } catch (error) {
        skipped.push({
          fileId: file.id,
          reason: error instanceof Error ? error.message : "unknown_error"
        });
      }
    }

    if (documents.length > 0) {
      return {
        documents,
        raw: {
          mode: "live",
          filesConsidered: files.length,
          skipped
        }
      };
    }

    if (useDemoFallback) {
      return {
        documents: createDemoDocuments(config),
        raw: {
          mode: "demo-fallback",
          reason: "no_text_documents",
          filesConsidered: files.length,
          skipped
        }
      };
    }

    return {
      documents: [],
      raw: {
        mode: "empty",
        reason: "no_text_documents",
        filesConsidered: files.length,
        skipped
      }
    };
  }
}
