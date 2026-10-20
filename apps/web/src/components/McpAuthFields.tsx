/**
 * Phase 10.5 — auth settings of an HTTP MCP server in the registry form.
 * They live in the connection JSON (`authType`, and `oauth.clientId` /
 * `oauth.scope` for OAuth 2.1), so these fields read and rewrite that JSON;
 * secrets never go here.
 */

type AuthType = "none" | "bearer" | "basic" | "oauth";

const AUTH_OPTIONS: Array<{ value: AuthType; label: string }> = [
  { value: "none", label: "None" },
  { value: "bearer", label: "Bearer token" },
  { value: "basic", label: "Basic" },
  { value: "oauth", label: "OAuth 2.1" }
];

function parseConnection(json: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = json.trim() ? JSON.parse(json) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function readOAuth(connection: Record<string, unknown>): Record<string, unknown> {
  const raw = connection.oauth;
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
}

export function McpAuthFields({
  connectionJson,
  onConnectionJsonChange
}: {
  connectionJson: string;
  onConnectionJsonChange: (next: string) => void;
}) {
  const connection = parseConnection(connectionJson);
  if (!connection) {
    return <small className="kb-subtle">Fix the connection JSON to edit auth settings here.</small>;
  }
  const rawType = String(connection.authType ?? "none").toLowerCase();
  const authType: AuthType = AUTH_OPTIONS.some((option) => option.value === rawType) ? (rawType as AuthType) : "none";
  const oauth = readOAuth(connection);

  const write = (next: Record<string, unknown>) => onConnectionJsonChange(JSON.stringify(next, null, 2));

  const setAuthType = (value: AuthType) => {
    const next: Record<string, unknown> = { ...connection, authType: value };
    if (value !== "oauth") delete next.oauth;
    write(next);
  };

  const setOAuthField = (key: "clientId" | "scope", value: string) => {
    const nextOAuth: Record<string, unknown> = { ...oauth };
    if (value.trim()) nextOAuth[key] = value;
    else delete nextOAuth[key];
    const next: Record<string, unknown> = { ...connection };
    if (Object.keys(nextOAuth).length > 0) next.oauth = nextOAuth;
    else delete next.oauth;
    write(next);
  };

  return (
    <div className="mcp-auth-fields">
      <label>
        Auth
        <select aria-label="Auth type" value={authType} onChange={(event) => setAuthType(event.target.value as AuthType)}>
          {AUTH_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      {authType === "oauth" && (
        <div className="kb-form-row kb-form-row-2">
          <label>
            Client ID
            <input
              type="text"
              aria-label="OAuth client ID"
              value={typeof oauth.clientId === "string" ? oauth.clientId : ""}
              onChange={(event) => setOAuthField("clientId", event.target.value)}
              placeholder="Empty = register automatically"
            />
          </label>
          <label>
            Scope
            <input
              type="text"
              aria-label="OAuth scope"
              value={typeof oauth.scope === "string" ? oauth.scope : ""}
              onChange={(event) => setOAuthField("scope", event.target.value)}
              placeholder="Server default"
            />
          </label>
        </div>
      )}
      {authType === "oauth" && (
        <small className="kb-subtle">
          Leave Client ID empty to use dynamic client registration. For a pre-registered client with a secret, pick
          the secret under Auth secret. Save, then use Connect on the server page.
        </small>
      )}
    </div>
  );
}
