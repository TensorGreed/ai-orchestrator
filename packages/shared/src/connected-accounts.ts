/**
 * Connected accounts: credentials made by signing in to a provider (OAuth 2.0 authorization code + PKCE) instead of
 * pasting a token. Each deployment registers its own OAuth app with the provider; nothing is brokered.
 *
 * A connected account is a secret like any other (provider `oauth_account`): nodes reference it by
 * `secretRef.secretId`, its project and shares decide who may use it, and the API hands a run the current access
 * token (refreshed when due). The token set itself is never returned by any API.
 */

/** The secret provider id of a connected account. */
export const CONNECTED_ACCOUNT_SECRET_PROVIDER = "oauth_account";

export const CONNECTED_ACCOUNT_PROVIDER_IDS = ["slack", "google", "github", "microsoft", "notion"] as const;
export type ConnectedAccountProviderId = (typeof CONNECTED_ACCOUNT_PROVIDER_IDS)[number];

export const CONNECTED_ACCOUNT_PROVIDER_LABELS: Readonly<Record<ConnectedAccountProviderId, string>> = {
  slack: "Slack",
  google: "Google",
  github: "GitHub",
  microsoft: "Microsoft",
  notion: "Notion"
};

export function isConnectedAccountProviderId(value: unknown): value is ConnectedAccountProviderId {
  return typeof value === "string" && (CONNECTED_ACCOUNT_PROVIDER_IDS as readonly string[]).includes(value);
}

/**
 * Nodes that can use a connected account in their `secretRef`, and the provider it must come from. The node editor
 * offers "Connect <provider>" in the credential picker of these nodes.
 */
export const NODE_CONNECTED_ACCOUNT_PROVIDERS: Readonly<Record<string, ConnectedAccountProviderId>> = {
  slack_send_message: "slack",
  google_sheets_read: "google",
  google_sheets_append: "google",
  google_sheets_update: "google",
  google_sheets_trigger: "google",
  google_drive_trigger: "google",
  google_drive_source: "google",
  google_calendar_create_event: "google",
  google_calendar_list_events: "google",
  github_action: "github",
  teams_send_message: "microsoft",
  notion_create_page: "notion",
  notion_query_database: "notion"
};

/** `connected`: usable. `needs_reconnect`: the provider refused a refresh or the token expired; sign in again. */
export type ConnectedAccountStatus = "connected" | "needs_reconnect";

/** What any API shows about a connected account. Never a token. */
export interface ConnectedAccountView {
  providerId: ConnectedAccountProviderId;
  /** The workspace, user or email the provider reported, for people to tell accounts apart. */
  accountLabel: string | null;
  /** Granted scopes as the provider reported them. */
  scopes: string[];
  status: ConnectedAccountStatus;
  /** When the current access token expires; null when the provider gave no expiry. */
  expiresAt: string | null;
  /** True when L2M can renew the access token without a new sign-in. */
  refreshable: boolean;
  lastError: string | null;
  connectedBy: string | null;
  connectedAt: string;
  lastRefreshAt: string | null;
}

/** One permission set a person can ask for when connecting (Google: Drive, Sheets, Gmail, Calendar). */
export interface ConnectedAccountScopeSet {
  id: string;
  label: string;
  /** What it lets nodes do, one short line. */
  description: string;
  default: boolean;
}

/** A provider as the Secrets page and the node pickers show it. */
export interface ConnectedAccountProviderView {
  id: ConnectedAccountProviderId;
  label: string;
  /** An OAuth app is set up for this project (or the whole instance), so people can connect. */
  configured: boolean;
  /** Where the app in use is set: this project, the whole instance, or nowhere yet. */
  appScope: "project" | "instance" | null;
  /** The app's client id (not secret), when one is set up. */
  clientId: string | null;
  /** Microsoft only: the tenant the app signs in to (`common` by default). */
  tenant: string | null;
  /** The exact redirect URL to register with the provider. */
  redirectUrl: string;
  /** Where the provider's app console is. */
  consoleUrl: string;
  /** Step-by-step setup, plain sentences. */
  setupSteps: string[];
  scopeSets: ConnectedAccountScopeSet[];
  /** The signed-in person may set up the app here (admin for the instance; secret:write for a project). */
  canConfigureProject: boolean;
  canConfigureInstance: boolean;
}
