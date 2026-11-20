---
title: "Connect accounts: sign in to Slack, Google, GitHub, Microsoft and Notion"
description: "Connect a Slack, Google, GitHub, Microsoft or Notion account to L2M with your own OAuth app, use it from nodes, and how tokens are renewed, reconnected and revoked. Also the HTTP Request node's Auth choices."
---

# Connect accounts

A connected account is a secret you get by signing in to a service instead of pasting a token. Nodes pick it like any
other secret; L2M keeps the token set encrypted and renews the access token before it expires. Connected accounts
work with:

| Service   | Nodes                                                                                         |
| --------- | --------------------------------------------------------------------------------------------- |
| Slack     | Slack Send Message (Auth Type: Bot Token or Connected Account)                                |
| Google    | Google Sheets (read, append, update, trigger), Google Drive Trigger, Google Calendar          |
| GitHub    | GitHub                                                                                        |
| Microsoft | Teams Send Message (with Team ID and Channel ID set)                                          |
| Notion    | Notion Create Page, Notion Query Database                                                     |

Any of them also works from the [HTTP Request node](#http-request-auth) with **Auth: Connected account**: Gmail,
Outlook mail, OneDrive and SharePoint files, or any other API of the same service the account was granted.

## Before you start: your own OAuth app

L2M is self-hosted, so each deployment signs in with an OAuth app of its own: no shared app or client id ships with
L2M. You create the app once per service in that service's developer console and enter its client id and client
secret on the **Secrets** page.

- An admin sets up an app for **all projects**. Anyone with `secret:write` in a project can set one up for **this
  project only**; a project's own app is used before the all-projects one.
- The client secret is stored encrypted like any secret and is never shown again or handed to nodes.

### The redirect URL

Every app needs this exact redirect URL:

```text
<APP_PUBLIC_URL>/api/connect/callback
```

`APP_PUBLIC_URL` is the address people open L2M at (for example `https://l2m.example.com`). When it is empty, the
first `WEB_ORIGIN` is used. The Secrets page shows the URL to copy. It has to be a plain base URL: no user name,
query or fragment.

## Setting up each service

Open **Secrets → Connected accounts**, press **Set up app** next to the service, and follow the steps shown there.
In short:

**Slack**: at api.slack.com/apps, create an app in your workspace. Under *OAuth & Permissions*, add the redirect URL
and the bot token scopes `chat:write` (and `chat:write.public` to post without joining channels). Turning on token
rotation lets L2M renew the token. Copy the client id and secret from *Basic Information*.

**Google**: in Google Cloud console, enable the APIs you need (Sheets, Drive, Gmail, Calendar), set up the OAuth
consent screen (Internal for a Workspace organisation, or External with test users), then create an *OAuth client
ID* of type *Web application* with the redirect URL as an authorised redirect URI.

**GitHub**: under *Settings → Developer settings → OAuth Apps* (yours or your organisation's), register an app with
the redirect URL as its authorization callback URL and generate a client secret.

**Microsoft**: in Microsoft Entra admin center, create an app registration, add the *Web* platform with the redirect
URL, create a client secret, and add the delegated Microsoft Graph permissions you need (`ChannelMessage.Send` for
Teams, `Mail.Send` / `Mail.Read` for Outlook, `Files.Read.All` for files). For a single-tenant app, also enter the
directory (tenant) id; it defaults to `common`.

**Notion**: at notion.so/profile/integrations, create a *Public* integration with the redirect URL and the
capabilities your workflows need. When you connect, Notion asks which pages the integration may use.

## Connecting

Press **Connect** next to the service. A window opens at the service's sign-in page; after you approve, it closes and
the account appears with:

- its name (`Slack · Acme`, `Google · ana@example.com`), the workspace, user or email the service reported;
- **Connected** or **Needs reconnect**;
- the scopes granted and when the current token expires.

Google, Microsoft, Slack and GitHub let you choose what to ask for (**Ask for** checkboxes): Google offers Sheets,
Drive (read), Gmail and Calendar; Microsoft offers Teams, Outlook mail and files. Tick what the workflows need before
pressing Connect. A node's credential picker also offers **Connect &lt;service&gt;…**, which connects with the default
choices and picks the new account.

The sign-in uses the authorization code flow with PKCE. The request carries a one-time `state` bound to your session
and user; the callback finishes only in the same signed-in session, once, within the sign-in time limit, and checks
again that you may still create secrets in the project.

## Tokens, renewal and reconnecting

- A run gets only the current access token; the refresh token never leaves the API.
- L2M renews the access token shortly before it expires, and once more when a service answers a request with 401.
  Renewals of one account do not overlap, also across API instances.
- **Refresh** on the Secrets page renews it now.
- When the service refuses to renew (the person revoked access, the app's secret changed, the refresh token expired),
  the account shows **Needs reconnect**, runs that use it fail with a message saying so, and the audit log records
  `oauth_account.refresh_failed`. **Reconnect** signs in again and keeps the same secret, so workflows do not change.
  A network failure does not mark the account; the next use tries again.
- A Slack app without token rotation issues tokens that do not expire; there is nothing to renew.

## Disconnecting

**Disconnect** revokes the token at the service where it offers that (Slack, Google, GitHub) and deletes the secret.
Microsoft and Notion tokens are deleted from L2M; remove the app's access in the service to end them there too.
Deleting the secret through `DELETE /api/secrets/:id` does the same.

## Permissions and audit

Connected accounts follow the [secret rules](./secrets.md): `secret:read` to see one, `secret:write` (or a
builder's `workflow:write` with `secret:use`) to connect, `secret:write` to reconnect, refresh or disconnect, and
`secret:use` to run with one. Project scope and secret shares apply unchanged. The audit log records
`oauth_app.saved`, `oauth_app.removed`, `oauth_account.connect_started`, `oauth_account.connected`,
`oauth_account.reconnected`, `oauth_account.connect_failed`, `oauth_account.refresh_failed` and
`oauth_account.disconnected`; none of them carries a token or a client secret.

L2M contacts only the service's own sign-in, token, profile and revoke hosts for an account, and does not follow
redirects there.

## HTTP Request Auth

The HTTP Request node has one **Auth** choice:

| Auth                        | What is sent                                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------------------- |
| None (default)              | Nothing.                                                                                        |
| Bearer token                | `Authorization: Bearer <secret>`.                                                               |
| Basic auth                  | `Authorization: Basic …`; the secret holds `user:password`.                                     |
| API key in a header         | The secret in the header you name (for example `X-API-Key`).                                    |
| API key in the query string | The secret as the query parameter you name (for example `api_key`).                             |
| OAuth2 client credentials   | An access token from the token URL, using the client id and the secret as the client secret.    |
| Connected account           | The connected account's access token as a bearer token, renewed as above.                       |

For **OAuth2 client credentials**, enter the token URL, the client id and an optional scope. L2M keeps the token
until shortly before it expires and asks again after a 401. The client credentials go in the request body; under
**More**, *Send client credentials* switches to a basic auth header for services that want that. The token request
follows the same [outbound URL checks](./outbound-url-checks.md) as the node.

In the workflow JSON this is `secretRef` plus `secretAuth`:

```json
{ "secretRef": { "secretId": "sec_..." }, "secretAuth": { "type": "connected" } }
```

```json
{
  "secretRef": { "secretId": "sec_..." },
  "secretAuth": {
    "type": "oauth2_client_credentials",
    "tokenUrl": "https://auth.example.com/oauth/token",
    "clientId": "app-1",
    "scope": "read",
    "clientAuth": "body"
  }
}
```

A node with a secret and no `secretAuth` sends it as a bearer token, as before. A workflow imported from another
builder gets the matching Auth choice for basic, header, query and bearer credentials, and **Connected account** for
a Slack, Google, GitHub, Microsoft or Notion OAuth credential; the import report says what to check.

## API

| Method and path                                        | Who                                                    |
| ------------------------------------------------------ | ------------------------------------------------------ |
| `GET /api/connect/providers?projectId=`                | `secret:read`: services, app status, the redirect URL  |
| `PUT /api/connect/providers/:service/app`              | admin (all projects) or `secret:write` (project)       |
| `DELETE /api/connect/providers/:service/app?projectId=` | the same                                              |
| `POST /api/connect/:service/start`                     | may create secrets in the project; returns the sign-in URL |
| `GET /api/connect/callback`                            | the service sends the browser here                     |
| `GET /api/connect/accounts/:secretId`                  | `secret:read`                                          |
| `POST /api/connect/accounts/:secretId/refresh`         | `secret:write`                                         |
| `DELETE /api/connect/accounts/:secretId`               | `secret:write`                                         |

`GET /api/secrets` lists connected accounts with provider `oauth_account` and a `connection` object (service, account
name, scopes, status, expiry). Secrets with that provider cannot be made through `POST /api/secrets`.

## Testing without a real service

`CONNECTED_ACCOUNTS_TEST_PROVIDER_URL` sends every connected-account request to a local mock server instead of the
services (only a loopback URL is accepted, and the API logs a warning when it is set). It is for tests and local
end-to-end runs; leave it empty otherwise.
