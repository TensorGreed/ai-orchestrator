/**
 * Phase 13.2 — an in-process OpenID Connect provider for tests. It answers through a fetch function (no sockets):
 * discovery, JWKS, token (checks the code, redirect_uri, PKCE S256 verifier and client authentication) and userinfo.
 * `authorize(url)` plays the user at the IdP and returns the callback URL with `code` and `state`.
 */
import crypto from "node:crypto";
import { SignJWT, exportJWK, generateKeyPair, type JWK, type CryptoKey } from "jose";

export interface MockOidcUser {
  sub: string;
  email?: string;
  email_verified?: boolean | string;
  name?: string;
  groups?: string[];
  [claim: string]: unknown;
}

interface PendingCode {
  clientId: string;
  redirectUri: string;
  nonce: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  user: MockOidcUser;
}

interface SigningKey {
  kid: string;
  alg: "RS256" | "ES256";
  privateKey: CryptoKey;
  publicJwk: JWK;
}

export interface MockOidcProviderOptions {
  issuer?: string;
  clientId?: string;
  /** Unset = public client (no client authentication expected). */
  clientSecret?: string;
  authMethods?: string[];
  alg?: "RS256" | "ES256";
}

async function makeKey(alg: "RS256" | "ES256"): Promise<SigningKey> {
  const { privateKey, publicKey } = await generateKeyPair(alg, { extractable: true });
  const kid = `k_${crypto.randomBytes(6).toString("hex")}`;
  const publicJwk = { ...(await exportJWK(publicKey)), kid, alg, use: "sig" };
  return { kid, alg, privateKey, publicJwk };
}

export class MockOidcProvider {
  readonly issuer: string;
  readonly clientId: string;
  readonly clientSecret?: string;
  user: MockOidcUser = { sub: "user-1", email: "alice@example.com", email_verified: true, name: "Alice", groups: [] };
  /** Extra or replacement ID token claims for the next token responses (e.g. a wrong `aud`). */
  idTokenOverrides: Record<string, unknown> = {};
  /** Claims the userinfo endpoint returns in addition to the user. */
  userinfoExtra: Record<string, unknown> = {};
  /** Claims left out of the ID token (they are still in userinfo). */
  omitFromIdToken: string[] = [];
  jwksFetches = 0;
  userinfoCalls = 0;
  readonly tokenRequests: Array<{ body: URLSearchParams; authorization: string | null }> = [];
  private keys: SigningKey[] = [];
  /** Keys signing new tokens but not yet published in the JWKS (to simulate rotation). */
  private signingKey!: SigningKey;
  private publishedKids = new Set<string>();
  private readonly codes = new Map<string, PendingCode>();
  private readonly authMethods?: string[];
  private readonly alg: "RS256" | "ES256";

  private constructor(options: MockOidcProviderOptions) {
    this.issuer = options.issuer ?? "https://idp.example.test/realms/l2m";
    this.clientId = options.clientId ?? "l2m-client";
    this.clientSecret = options.clientSecret;
    this.authMethods = options.authMethods;
    this.alg = options.alg ?? "RS256";
  }

  static async create(options: MockOidcProviderOptions = {}): Promise<MockOidcProvider> {
    const provider = new MockOidcProvider(options);
    const key = await makeKey(provider.alg);
    provider.keys.push(key);
    provider.publishedKids.add(key.kid);
    provider.signingKey = key;
    return provider;
  }

  /** Signs with a fresh key that the JWKS publishes too (an IdP key rotation). */
  async rotateKey(): Promise<void> {
    const key = await makeKey(this.alg);
    this.keys.push(key);
    this.publishedKids.add(key.kid);
    this.signingKey = key;
  }

  /** Signs with a fresh key that the JWKS never publishes (an attacker's key with an unknown kid). */
  async useUnpublishedKey(): Promise<void> {
    const key = await makeKey(this.alg);
    this.keys.push(key);
    this.signingKey = key;
  }

  get discovery(): Record<string, unknown> {
    const base = this.issuer.replace(/\/+$/, "");
    return {
      issuer: this.issuer,
      authorization_endpoint: `${base}/protocol/openid-connect/auth`,
      token_endpoint: `${base}/protocol/openid-connect/token`,
      jwks_uri: `${base}/protocol/openid-connect/certs`,
      userinfo_endpoint: `${base}/protocol/openid-connect/userinfo`,
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: [this.alg],
      code_challenge_methods_supported: ["S256"],
      ...(this.authMethods ? { token_endpoint_auth_methods_supported: this.authMethods } : {})
    };
  }

  /** Signs arbitrary ID token claims with the current signing key (for direct validation tests). */
  async sign(claims: Record<string, unknown>, header: Record<string, unknown> = {}): Promise<string> {
    return await new SignJWT(claims)
      .setProtectedHeader({ alg: this.signingKey.alg, kid: this.signingKey.kid, typ: "JWT", ...header })
      .sign(this.signingKey.privateKey);
  }

  jwks(): { keys: JWK[] } {
    return { keys: this.keys.filter((key) => this.publishedKids.has(key.kid)).map((key) => key.publicJwk) };
  }

  /** The user approves at the IdP: returns the redirect back to the app with a fresh code. */
  authorize(authorizationUrl: string): string {
    const url = new URL(authorizationUrl);
    const params = url.searchParams;
    const code = crypto.randomBytes(16).toString("hex");
    this.codes.set(code, {
      clientId: params.get("client_id") ?? "",
      redirectUri: params.get("redirect_uri") ?? "",
      nonce: params.get("nonce") ?? "",
      codeChallenge: params.get("code_challenge") ?? "",
      codeChallengeMethod: params.get("code_challenge_method") ?? "",
      user: { ...this.user }
    });
    const callback = new URL(params.get("redirect_uri") ?? "");
    callback.searchParams.set("code", code);
    callback.searchParams.set("state", params.get("state") ?? "");
    return callback.toString();
  }

  readonly fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const base = this.issuer.replace(/\/+$/, "");
    const path = `${url.origin}${url.pathname}`;
    if (path === `${base}/.well-known/openid-configuration`) {
      return Response.json(this.discovery);
    }
    if (path === this.discovery.jwks_uri) {
      this.jwksFetches += 1;
      return Response.json(this.jwks());
    }
    if (path === this.discovery.token_endpoint && init?.method === "POST") {
      return await this.token(init);
    }
    if (path === this.discovery.userinfo_endpoint) {
      this.userinfoCalls += 1;
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      if (!auth.startsWith("Bearer at_")) return Response.json({ error: "invalid_token" }, { status: 401 });
      const sub = auth.slice("Bearer at_".length);
      return Response.json({ ...this.user, sub, ...this.userinfoExtra });
    }
    return Response.json({ error: "not_found" }, { status: 404 });
  };

  private async token(init: RequestInit): Promise<Response> {
    const body = new URLSearchParams(String(init.body ?? ""));
    const authorization = new Headers(init.headers).get("authorization");
    this.tokenRequests.push({ body, authorization });
    const code = body.get("code") ?? "";
    const pending = this.codes.get(code);
    if (!pending) return Response.json({ error: "invalid_grant" }, { status: 400 });
    this.codes.delete(code);
    if (body.get("grant_type") !== "authorization_code") return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
    if (body.get("redirect_uri") !== pending.redirectUri) return Response.json({ error: "invalid_grant" }, { status: 400 });
    const verifier = body.get("code_verifier") ?? "";
    const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
    if (pending.codeChallengeMethod !== "S256" || challenge !== pending.codeChallenge) {
      return Response.json({ error: "invalid_grant", error_description: "PKCE verification failed" }, { status: 400 });
    }
    let clientId = body.get("client_id");
    let clientSecret = body.get("client_secret");
    if (authorization?.startsWith("Basic ")) {
      const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8");
      const separator = decoded.indexOf(":");
      clientId = decodeURIComponent(decoded.slice(0, separator));
      clientSecret = decodeURIComponent(decoded.slice(separator + 1));
    }
    if (clientId !== this.clientId || clientId !== pending.clientId) return Response.json({ error: "invalid_client" }, { status: 401 });
    if (this.clientSecret !== undefined && clientSecret !== this.clientSecret) return Response.json({ error: "invalid_client" }, { status: 401 });

    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = {
      ...pending.user,
      iss: this.issuer,
      aud: this.clientId,
      iat: now,
      exp: now + 300,
      nonce: pending.nonce,
      ...this.idTokenOverrides
    };
    for (const key of this.omitFromIdToken) delete claims[key];
    return Response.json({
      access_token: `at_${pending.user.sub}`,
      token_type: "Bearer",
      expires_in: 300,
      id_token: await this.sign(claims)
    });
  }
}
