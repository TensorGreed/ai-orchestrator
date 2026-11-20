/**
 * Connected accounts in the browser: the sign-in popup and its message from the callback page, the labels pickers
 * and the Secrets page show, and the HTTP Request node's Auth choice. Tokens never reach the browser; the callback
 * page only says which secret was saved.
 */
import {
  CONNECTED_ACCOUNT_PROVIDER_LABELS,
  CONNECTED_ACCOUNT_SECRET_PROVIDER,
  type ConnectedAccountProviderId,
  type ConnectedAccountView,
  type HttpSecretAuth
} from "@ai-orchestrator/shared";
import { startConnect } from "./api";

export const CONNECT_MESSAGE_TYPE = "l2m:oauth-account";

export interface ConnectResult {
  ok: boolean;
  providerId: string;
  secretId?: string;
  error?: string;
  /**
   * The window closed without a message. The sign-in may still have finished (a provider page can cut the window off
   * from this one), so callers reload the list instead of reporting a failure.
   */
  closed?: boolean;
}

let popupCounter = 0;

/** The callback page's message, only from this app's own origin; anything else is ignored. */
export function readConnectMessage(event: { origin: string; data: unknown }, expectedOrigin: string): ConnectResult | null {
  if (event.origin !== expectedOrigin) return null;
  const data = event.data;
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  if (record.type !== CONNECT_MESSAGE_TYPE || typeof record.providerId !== "string") return null;
  return {
    ok: record.ok === true,
    providerId: record.providerId,
    secretId: typeof record.secretId === "string" ? record.secretId : undefined,
    error: typeof record.error === "string" ? record.error : undefined
  };
}

export function providerLabel(providerId: string): string {
  return (CONNECTED_ACCOUNT_PROVIDER_LABELS as Record<string, string>)[providerId] ?? providerId;
}

export function isConnectedAccount(secret: { provider: string }): boolean {
  return secret.provider === CONNECTED_ACCOUNT_SECRET_PROVIDER;
}

/** How a secret reads in a picker. */
export function secretOptionLabel(secret: { name: string; provider: string; connection?: ConnectedAccountView }): string {
  if (!isConnectedAccount(secret)) return `${secret.name} (${secret.provider})`;
  return secret.connection?.status === "needs_reconnect" ? `${secret.name} (needs reconnect)` : `${secret.name} (connected account)`;
}

function inTime(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "less than a minute";
  if (minutes < 90) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} days`;
}

/** One line under an account: its state and when the token expires. */
export function connectedAccountSummary(view: ConnectedAccountView, now = Date.now()): string {
  if (view.status === "needs_reconnect") return `Needs reconnect${view.lastError ? `: ${view.lastError}` : ""}`;
  const expires = view.expiresAt ? Date.parse(view.expiresAt) : NaN;
  if (Number.isNaN(expires)) return view.refreshable ? "Token renews automatically" : "Token does not expire";
  const left = expires - now;
  const when = left > 0 ? `expires in ${inTime(left)}` : "expired";
  return view.refreshable ? `Token renews automatically · ${when}` : `Token ${when}; reconnect when it does`;
}

/**
 * Opens the provider's sign-in in a popup and waits for the callback page's message (or for the popup to close).
 * The popup is opened before the first await so browsers treat it as a response to the click, and gets its own name
 * so two sign-ins never share a window. A blocked popup is reported; this page is never navigated away (an open
 * canvas would lose its unsaved edits).
 */
export async function connectAccountInPopup(input: {
  providerId: ConnectedAccountProviderId | string;
  projectId?: string;
  scopeSets?: string[];
  reconnectSecretId?: string;
}): Promise<ConnectResult> {
  popupCounter += 1;
  const popup = window.open("about:blank", `l2m-connect-${Date.now()}-${popupCounter}`, "popup,width=560,height=720");
  if (!popup) {
    return { ok: false, providerId: input.providerId, error: "Your browser blocked the sign-in window. Allow pop-ups for this site and press Connect again." };
  }
  let authorizationUrl: string;
  try {
    const started = await startConnect(input.providerId, {
      ...(input.projectId ? { projectId: input.projectId } : {}),
      ...(input.scopeSets ? { scopeSets: input.scopeSets } : {}),
      ...(input.reconnectSecretId ? { reconnectSecretId: input.reconnectSecretId } : {})
    });
    authorizationUrl = started.authorizationUrl;
  } catch (error) {
    popup.close();
    throw error;
  }
  popup.location.href = authorizationUrl;
  return await new Promise<ConnectResult>((resolve) => {
    let settled = false;
    const finish = (result: ConnectResult) => {
      if (settled) return;
      settled = true;
      window.removeEventListener("message", onMessage);
      window.clearInterval(timer);
      resolve(result);
    };
    const onMessage = (event: MessageEvent) => {
      const message = readConnectMessage(event, window.location.origin);
      if (message) finish(message);
    };
    window.addEventListener("message", onMessage);
    const timer = window.setInterval(() => {
      if (popup.closed) {
        finish({ ok: false, closed: true, providerId: input.providerId, error: "The sign-in window closed before it reported back. If you finished signing in, the account is in the list." });
      }
    }, 500);
  });
}

// ---- HTTP Request: one Auth choice -------------------------------------------------------------------------------

export type HttpAuthMode = "none" | "bearer" | "basic" | "header" | "query" | "oauth2_client_credentials" | "connected";

export const HTTP_AUTH_OPTIONS: Array<{ value: HttpAuthMode; label: string }> = [
  { value: "none", label: "None" },
  { value: "bearer", label: "Bearer token" },
  { value: "basic", label: "Basic auth" },
  { value: "header", label: "API key in a header" },
  { value: "query", label: "API key in the query string" },
  { value: "oauth2_client_credentials", label: "OAuth2 client credentials" },
  { value: "connected", label: "Connected account" }
];

/** The Auth choice a node's config shows. A secret without `secretAuth` has always meant a bearer token. */
export function httpAuthMode(config: Record<string, unknown>): HttpAuthMode {
  const auth = config.secretAuth;
  if (auth && typeof auth === "object" && typeof (auth as { type?: unknown }).type === "string") {
    const type = (auth as { type: string }).type;
    if (HTTP_AUTH_OPTIONS.some((option) => option.value === type)) return type as HttpAuthMode;
  }
  const ref = config.secretRef;
  return ref && typeof ref === "object" && typeof (ref as { secretId?: unknown }).secretId === "string" && (ref as { secretId: string }).secretId
    ? "bearer"
    : "none";
}

/** The config after picking `mode`: `None` clears the secret; other choices keep it and set `secretAuth`. */
export function applyHttpAuthMode(config: Record<string, unknown>, mode: HttpAuthMode): Record<string, unknown> {
  const previous = (config.secretAuth && typeof config.secretAuth === "object" ? config.secretAuth : {}) as Partial<Record<string, unknown>>;
  const name = typeof previous.name === "string" ? previous.name : "";
  let secretAuth: HttpSecretAuth | undefined;
  switch (mode) {
    case "none":
      return { ...config, secretRef: undefined, secretAuth: undefined };
    case "bearer":
      secretAuth = { type: "bearer" };
      break;
    case "basic":
      secretAuth = { type: "basic" };
      break;
    case "header":
      secretAuth = { type: "header", name: name || "X-API-Key" };
      break;
    case "query":
      secretAuth = { type: "query", name: name || "api_key" };
      break;
    case "connected":
      secretAuth = { type: "connected" };
      break;
    case "oauth2_client_credentials":
      secretAuth = {
        type: "oauth2_client_credentials",
        tokenUrl: typeof previous.tokenUrl === "string" ? previous.tokenUrl : "",
        clientId: typeof previous.clientId === "string" ? previous.clientId : "",
        clientAuth: previous.clientAuth === "basic" ? "basic" : "body",
        ...(typeof previous.scope === "string" && previous.scope ? { scope: previous.scope } : {})
      };
      break;
  }
  // A connected account and a typed secret are different kinds; switching between them clears the pick.
  const ref = config.secretRef;
  const keepSecret = (mode === "connected") === (httpAuthMode(config) === "connected");
  return { ...config, secretAuth, secretRef: keepSecret ? ref : undefined };
}
