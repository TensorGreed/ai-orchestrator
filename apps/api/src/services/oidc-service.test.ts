import crypto from "node:crypto";
import { UnsecuredJWT, createLocalJWKSet, type JWTVerifyGetKey } from "jose";
import { describe, expect, it } from "vitest";
import { parseConfig, resolveOidcSettings, type OidcSettings } from "../config.js";
import type { Store } from "../db/store.js";
import { MockOidcProvider } from "../test-support/mock-oidc-provider.js";
import {
  JwksCache,
  OidcError,
  oidcIdentitySubject,
  OidcService,
  deriveOidcFlowKey,
  extractGroups,
  oidcUserErrorCode,
  openOidcFlow,
  sealOidcFlow,
  validateIdToken
} from "./oidc-service.js";

const NONCE = "nonce-123";

function baseClaims(provider: MockOidcProvider, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return { iss: provider.issuer, aud: provider.clientId, sub: "user-1", iat: now, exp: now + 300, nonce: NONCE, ...extra };
}

function localKeys(provider: MockOidcProvider): JWTVerifyGetKey {
  return createLocalJWKSet(provider.jwks());
}

async function expectRejected(promise: Promise<unknown>, reason: RegExp): Promise<void> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught
  );
  expect(error).toBeInstanceOf(OidcError);
  expect((error as OidcError).code).toBe("invalid_id_token");
  expect((error as OidcError).message).toMatch(reason);
}

function settingsFor(provider: MockOidcProvider, overrides: Partial<OidcSettings> = {}): OidcSettings {
  return {
    issuer: provider.issuer,
    clientId: provider.clientId,
    clientSecret: provider.clientSecret,
    redirectUrl: "http://localhost:5173/api/auth/oidc/callback",
    scopes: "openid email profile",
    groupsClaim: "groups",
    requireEmailVerified: true,
    postLoginUrl: "http://localhost:5173/",
    allowedEmailDomains: [],
    allowedGroups: [],
    ...overrides
  };
}

const noStore = {} as Store;

describe("OIDC ID token validation", () => {
  it("accepts a well-formed RS256 token and an ES256 token", async () => {
    const rsa = await MockOidcProvider.create();
    const payload = await validateIdToken(await rsa.sign(baseClaims(rsa)), {
      issuer: rsa.issuer,
      clientId: rsa.clientId,
      nonce: NONCE,
      getKey: localKeys(rsa)
    });
    expect(payload.sub).toBe("user-1");

    const ec = await MockOidcProvider.create({ alg: "ES256" });
    const ecPayload = await validateIdToken(await ec.sign(baseClaims(ec)), {
      issuer: ec.issuer,
      clientId: ec.clientId,
      nonce: NONCE,
      getKey: localKeys(ec)
    });
    expect(ecPayload.sub).toBe("user-1");
  });

  it("rejects a bad signature", async () => {
    const provider = await MockOidcProvider.create();
    const token = await provider.sign(baseClaims(provider));
    const [header, body, signature] = token.split(".");
    const flipped = Buffer.from(signature!, "base64url");
    flipped[0] = flipped[0]! ^ 0xff;
    const forged = `${header}.${body}.${flipped.toString("base64url")}`;
    await expectRejected(
      validateIdToken(forged, { issuer: provider.issuer, clientId: provider.clientId, nonce: NONCE, getKey: localKeys(provider) }),
      /signature/i
    );
    // A token with changed claims but the original signature fails too.
    const tamperedBody = Buffer.from(JSON.stringify({ ...baseClaims(provider), sub: "admin" })).toString("base64url");
    await expectRejected(
      validateIdToken(`${header}.${tamperedBody}.${signature}`, {
        issuer: provider.issuer,
        clientId: provider.clientId,
        nonce: NONCE,
        getKey: localKeys(provider)
      }),
      /signature/i
    );
  });

  it("rejects a wrong issuer and a wrong audience", async () => {
    const provider = await MockOidcProvider.create();
    const opts = { issuer: provider.issuer, clientId: provider.clientId, nonce: NONCE, getKey: localKeys(provider) };
    await expectRejected(validateIdToken(await provider.sign(baseClaims(provider, { iss: "https://evil.example" })), opts), /iss/);
    await expectRejected(validateIdToken(await provider.sign(baseClaims(provider, { aud: "other-client" })), opts), /aud/);
  });

  it("rejects expired tokens, tokens issued in the future and stale tokens, allowing small skew", async () => {
    const provider = await MockOidcProvider.create();
    const opts = { issuer: provider.issuer, clientId: provider.clientId, nonce: NONCE, getKey: localKeys(provider) };
    const now = Math.floor(Date.now() / 1000);
    await expectRejected(validateIdToken(await provider.sign(baseClaims(provider, { iat: now - 400, exp: now - 120 })), opts), /exp/);
    await expectRejected(validateIdToken(await provider.sign(baseClaims(provider, { iat: now + 600, exp: now + 900 })), opts), /iat/);
    await expectRejected(validateIdToken(await provider.sign(baseClaims(provider, { iat: now - 3600, exp: now + 3600 })), opts), /iat/);
    // 30 seconds past exp is inside the 60-second skew.
    const skewed = await validateIdToken(await provider.sign(baseClaims(provider, { iat: now - 200, exp: now - 30 })), opts);
    expect(skewed.sub).toBe("user-1");
  });

  it("rejects a nonce mismatch and a missing nonce", async () => {
    const provider = await MockOidcProvider.create();
    const opts = { issuer: provider.issuer, clientId: provider.clientId, nonce: NONCE, getKey: localKeys(provider) };
    await expectRejected(validateIdToken(await provider.sign(baseClaims(provider, { nonce: "other" })), opts), /nonce/);
    await expectRejected(validateIdToken(await provider.sign(baseClaims(provider, { nonce: undefined })), opts), /nonce/);
  });

  it("checks azp: required with several audiences, must be this client", async () => {
    const provider = await MockOidcProvider.create();
    const opts = { issuer: provider.issuer, clientId: provider.clientId, nonce: NONCE, getKey: localKeys(provider) };
    await expectRejected(
      validateIdToken(await provider.sign(baseClaims(provider, { aud: [provider.clientId, "other"] })), opts),
      /azp missing/
    );
    await expectRejected(
      validateIdToken(await provider.sign(baseClaims(provider, { aud: [provider.clientId, "other"], azp: "other" })), opts),
      /azp/
    );
    const ok = await validateIdToken(
      await provider.sign(baseClaims(provider, { aud: [provider.clientId, "other"], azp: provider.clientId })),
      opts
    );
    expect(ok.azp).toBe(provider.clientId);
  });

  it("rejects alg none and HS256 signed with the public key material", async () => {
    const provider = await MockOidcProvider.create();
    const opts = { issuer: provider.issuer, clientId: provider.clientId, nonce: NONCE, getKey: localKeys(provider) };
    const unsecured = new UnsecuredJWT(baseClaims(provider)).encode();
    await expectRejected(validateIdToken(unsecured, opts), /alg|algorithm/i);

    // Classic key-confusion: HMAC "signed" with the public key as the shared secret.
    const publicJwk = provider.jwks().keys[0]!;
    const secret = Buffer.from(JSON.stringify(publicJwk));
    const header = Buffer.from(JSON.stringify({ alg: "HS256", kid: publicJwk.kid, typ: "JWT" })).toString("base64url");
    const body = Buffer.from(JSON.stringify(baseClaims(provider))).toString("base64url");
    const mac = crypto.createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
    await expectRejected(validateIdToken(`${header}.${body}.${mac}`, opts), /alg/i);
  });
});

describe("OIDC JWKS cache", () => {
  it("refetches the JWKS once on an unknown kid (key rotation), rate limited by the cooldown", async () => {
    const provider = await MockOidcProvider.create();
    let now = 1_000_000;
    let fetches = 0;
    const cache = new JwksCache("https://idp/certs", async () => {
      fetches += 1;
      return provider.jwks();
    }, () => now, 30_000);
    const opts = () => ({ issuer: provider.issuer, clientId: provider.clientId, nonce: NONCE, getKey: cache.getKey });

    await validateIdToken(await provider.sign(baseClaims(provider)), { ...opts(), currentDate: new Date() });
    expect(fetches).toBe(1);

    await provider.rotateKey();
    now += 60_000;
    const rotated = await validateIdToken(await provider.sign(baseClaims(provider)), opts());
    expect(rotated.sub).toBe("user-1");
    expect(fetches).toBe(2);

    // An unknown kid right after a fetch does not refetch (cooldown) and is rejected.
    await provider.useUnpublishedKey();
    await expectRejected(validateIdToken(await provider.sign(baseClaims(provider)), opts()), /no applicable key|JWKS/i);
    expect(fetches).toBe(2);
    // After the cooldown it refetches once, still finds nothing, and rejects.
    now += 31_000;
    await expectRejected(validateIdToken(await provider.sign(baseClaims(provider)), opts()), /no applicable key|JWKS/i);
    expect(fetches).toBe(3);
  });

  it("keeps the last good key set when a periodic refresh fails, and throws only with no cached keys", async () => {
    const provider = await MockOidcProvider.create();
    let now = 1_000_000;
    let fail = false;
    let fetches = 0;
    const logged: string[] = [];
    const cache = new JwksCache(
      "https://idp/certs",
      async () => {
        fetches += 1;
        if (fail) throw new OidcError("discovery_failed", "JWKS fetch failed: HTTP 503");
        return provider.jwks();
      },
      () => now,
      30_000,
      (message) => logged.push(message)
    );
    const opts = { issuer: provider.issuer, clientId: provider.clientId, nonce: NONCE, getKey: cache.getKey };
    await validateIdToken(await provider.sign(baseClaims(provider)), opts);

    fail = true;
    now += 2 * 60 * 60 * 1000; // past the one-hour TTL
    const stillValid = await validateIdToken(await provider.sign(baseClaims(provider)), opts);
    expect(stillValid.sub).toBe("user-1");
    expect(fetches).toBe(2);
    expect(logged).toEqual(["OIDC JWKS refresh failed; keeping the cached keys"]);
    // A failed refresh is not retried on every login: the cooldown applies.
    await validateIdToken(await provider.sign(baseClaims(provider)), opts);
    expect(fetches).toBe(2);

    const empty = new JwksCache("https://idp/certs", async () => {
      throw new OidcError("discovery_failed", "JWKS fetch failed: HTTP 503");
    }, () => now, 30_000);
    await expect(empty.getKey({ alg: "RS256", kid: "x" }, { payload: "", signature: "" } as never)).rejects.toMatchObject({
      code: "discovery_failed"
    });
  });
});

describe("OIDC flow cookie", () => {
  it("round-trips, and rejects tampering, another key and expiry", () => {
    const key = deriveOidcFlowKey(crypto.randomBytes(32).toString("base64"));
    const flow = { v: 1 as const, state: "s", nonce: "n", verifier: "v", createdAt: 1_000_000 };
    const sealed = sealOidcFlow(flow, key);
    expect(sealed).not.toContain("verifier");
    expect(openOidcFlow(sealed, key, 1_000_000 + 1000)).toEqual(flow);
    const raw = Buffer.from(sealed, "base64url");
    raw[raw.length - 1] = raw[raw.length - 1]! ^ 0x01;
    expect(openOidcFlow(raw.toString("base64url"), key, 1_000_000)).toBeNull();
    expect(openOidcFlow(sealed, deriveOidcFlowKey(crypto.randomBytes(32).toString("base64")), 1_000_000)).toBeNull();
    expect(openOidcFlow(sealed, key, 1_000_000 + 11 * 60 * 1000)).toBeNull();
    expect(openOidcFlow(undefined, key, 1_000_000)).toBeNull();
    expect(openOidcFlow("garbage", key, 1_000_000)).toBeNull();
  });

  it("derives a stable key from the master key", () => {
    const master = crypto.randomBytes(32).toString("base64");
    expect(deriveOidcFlowKey(master).equals(deriveOidcFlowKey(master))).toBe(true);
    expect(deriveOidcFlowKey(undefined)).toHaveLength(32);
  });
});

describe("OIDC login flow (service level)", () => {
  async function start(provider: MockOidcProvider, overrides: Partial<OidcSettings> = {}) {
    const service = new OidcService(noStore, settingsFor(provider, overrides), {
      flowKey: crypto.randomBytes(32),
      fetch: provider.fetch
    });
    const begun = await service.beginLogin();
    return { service, begun };
  }

  it("sends PKCE S256, state and nonce, and completes with a verified profile", async () => {
    const provider = await MockOidcProvider.create({ clientSecret: "s3cret" });
    provider.user = { sub: "u-42", email: "Bob@Example.com", email_verified: true, name: "Bob", groups: ["eng", "ops"] };
    const { service, begun } = await start(provider);
    const url = new URL(begun.authorizationUrl);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(url.searchParams.get("nonce")).toBeTruthy();
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(begun.authorizationUrl).not.toContain("s3cret");

    const callback = new URL(provider.authorize(begun.authorizationUrl));
    const profile = await service.completeLogin({ query: Object.fromEntries(callback.searchParams), flowCookie: begun.flowCookie });
    expect(profile).toEqual({
      issuer: provider.issuer,
      subject: "u-42",
      identityKey: `${provider.issuer}#u-42`,
      email: "bob@example.com",
      emailVerified: true,
      displayName: "Bob",
      groups: ["eng", "ops"]
    });
    // Confidential client: client_secret_basic, secret never in the body.
    expect(provider.tokenRequests[0]!.authorization).toMatch(/^Basic /);
    expect(provider.tokenRequests[0]!.body.get("client_secret")).toBeNull();
  });

  it("uses client_secret_post when the IdP only supports it, and none for public clients", async () => {
    const post = await MockOidcProvider.create({ clientSecret: "s3cret", authMethods: ["client_secret_post"] });
    const a = await start(post);
    const cbA = new URL(post.authorize(a.begun.authorizationUrl));
    await a.service.completeLogin({ query: Object.fromEntries(cbA.searchParams), flowCookie: a.begun.flowCookie });
    expect(post.tokenRequests[0]!.authorization).toBeNull();
    expect(post.tokenRequests[0]!.body.get("client_secret")).toBe("s3cret");

    const pub = await MockOidcProvider.create();
    const b = await start(pub);
    const cbB = new URL(pub.authorize(b.begun.authorizationUrl));
    await b.service.completeLogin({ query: Object.fromEntries(cbB.searchParams), flowCookie: b.begun.flowCookie });
    expect(pub.tokenRequests[0]!.authorization).toBeNull();
    expect(pub.tokenRequests[0]!.body.get("client_id")).toBe(pub.clientId);
    expect(pub.tokenRequests[0]!.body.get("client_secret")).toBeNull();
  });

  it("rejects a state mismatch, a missing flow cookie and a flow cookie from another login", async () => {
    const provider = await MockOidcProvider.create();
    const { service, begun } = await start(provider);
    const callback = new URL(provider.authorize(begun.authorizationUrl));
    const query = Object.fromEntries(callback.searchParams);
    await expect(service.completeLogin({ query: { ...query, state: "forged" }, flowCookie: begun.flowCookie })).rejects.toMatchObject({
      code: "state_mismatch"
    });
    await expect(service.completeLogin({ query, flowCookie: undefined })).rejects.toMatchObject({ code: "state_mismatch" });
    const other = await service.beginLogin();
    await expect(service.completeLogin({ query, flowCookie: other.flowCookie })).rejects.toMatchObject({ code: "state_mismatch" });
    expect(provider.tokenRequests).toHaveLength(0);
  });

  it("fails the code exchange when the PKCE verifier does not match (code injected into another flow)", async () => {
    const provider = await MockOidcProvider.create();
    const { service, begun } = await start(provider);
    // An attacker's code was issued for a different PKCE challenge, but carries the victim flow's state.
    const attacker = await service.beginLogin();
    const attackerCallback = new URL(provider.authorize(attacker.authorizationUrl));
    const victimState = new URL(begun.authorizationUrl).searchParams.get("state")!;
    await expect(
      service.completeLogin({
        query: { code: attackerCallback.searchParams.get("code"), state: victimState },
        flowCookie: begun.flowCookie
      })
    ).rejects.toMatchObject({ code: "token_exchange_failed" });
  });

  it("rejects the IdP's error response and a mismatched iss parameter", async () => {
    const provider = await MockOidcProvider.create();
    const { service, begun } = await start(provider);
    const state = new URL(begun.authorizationUrl).searchParams.get("state");
    await expect(
      service.completeLogin({ query: { error: "access_denied", state }, flowCookie: begun.flowCookie })
    ).rejects.toMatchObject({ code: "idp_error" });
    const callback = new URL(provider.authorize(begun.authorizationUrl));
    await expect(
      service.completeLogin({
        query: { ...Object.fromEntries(callback.searchParams), iss: "https://evil.example" },
        flowCookie: begun.flowCookie
      })
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("rejects an ID token whose nonce is not the one of this flow", async () => {
    const provider = await MockOidcProvider.create();
    const { service, begun } = await start(provider);
    provider.idTokenOverrides = { nonce: "replayed-nonce" };
    const callback = new URL(provider.authorize(begun.authorizationUrl));
    await expect(
      service.completeLogin({ query: Object.fromEntries(callback.searchParams), flowCookie: begun.flowCookie })
    ).rejects.toMatchObject({ code: "invalid_id_token" });
  });

  it("fills a missing email and groups from userinfo only when its sub matches", async () => {
    const provider = await MockOidcProvider.create();
    provider.user = { sub: "u-7", email: "carol@example.com", email_verified: true, groups: ["eng"] };
    provider.omitFromIdToken = ["email", "email_verified", "groups"];
    const { service, begun } = await start(provider);
    const callback = new URL(provider.authorize(begun.authorizationUrl));
    const profile = await service.completeLogin({ query: Object.fromEntries(callback.searchParams), flowCookie: begun.flowCookie });
    expect(profile).toMatchObject({ subject: "u-7", email: "carol@example.com", emailVerified: true, groups: ["eng"] });
    expect(provider.userinfoCalls).toBe(1);

    provider.userinfoExtra = { sub: "someone-else" };
    const again = await service.beginLogin();
    const cb2 = new URL(provider.authorize(again.authorizationUrl));
    const profile2 = await service.completeLogin({ query: Object.fromEntries(cb2.searchParams), flowCookie: again.flowCookie });
    expect(profile2.email).toBeUndefined();
    expect(profile2.groups).toEqual([]);
  });

  it("asks userinfo for email_verified when the ID token has email only, for the same sub and email", async () => {
    const provider = await MockOidcProvider.create();
    provider.user = { sub: "u-8", email: "dee@example.com", email_verified: true };
    provider.omitFromIdToken = ["email_verified"];
    const { service, begun } = await start(provider);
    const callback = new URL(provider.authorize(begun.authorizationUrl));
    const profile = await service.completeLogin({ query: Object.fromEntries(callback.searchParams), flowCookie: begun.flowCookie });
    expect(profile).toMatchObject({ email: "dee@example.com", emailVerified: true });
    expect(provider.userinfoCalls).toBe(1);

    // Userinfo vouches for a different address: its email_verified is not applied to the ID token's email.
    provider.userinfoExtra = { email: "other@example.com" };
    const again = await service.beginLogin();
    const cb2 = new URL(provider.authorize(again.authorizationUrl));
    const profile2 = await service.completeLogin({ query: Object.fromEntries(cb2.searchParams), flowCookie: again.flowCookie });
    expect(profile2).toMatchObject({ email: "dee@example.com", emailVerified: false });

    // Userinfo for another sub is ignored.
    provider.userinfoExtra = { sub: "someone-else" };
    const third = await service.beginLogin();
    const cb3 = new URL(provider.authorize(third.authorizationUrl));
    const profile3 = await service.completeLogin({ query: Object.fromEntries(cb3.searchParams), flowCookie: third.flowCookie });
    expect(profile3.emailVerified).toBe(false);
  });

  it("refuses a discovery document with a plain-http jwks_uri or token_endpoint on a non-loopback host", async () => {
    for (const key of ["jwks_uri", "token_endpoint"]) {
      const provider = await MockOidcProvider.create();
      const service = new OidcService(noStore, settingsFor(provider), {
        flowKey: crypto.randomBytes(32),
        fetch: async (input, init) => {
          if (input.endsWith("/.well-known/openid-configuration")) {
            return Response.json({ ...provider.discovery, [key]: "http://idp.example.test/insecure" });
          }
          return await provider.fetch(input, init);
        }
      });
      await expect(service.beginLogin()).rejects.toMatchObject({ code: "discovery_failed", message: expect.stringContaining(key) });
    }
  });

  it("remembers a failed discovery briefly instead of refetching on every login", async () => {
    const provider = await MockOidcProvider.create();
    let now = 5_000_000;
    let attempts = 0;
    let down = true;
    const service = new OidcService(noStore, settingsFor(provider), {
      flowKey: crypto.randomBytes(32),
      now: () => now,
      fetch: async (input, init) => {
        if (input.endsWith("/.well-known/openid-configuration")) {
          attempts += 1;
          if (down) return Response.json({ error: "temporarily_unavailable" }, { status: 503 });
        }
        return await provider.fetch(input, init);
      }
    });
    await expect(service.beginLogin()).rejects.toMatchObject({ code: "discovery_failed" });
    await expect(service.beginLogin()).rejects.toMatchObject({ code: "discovery_failed" });
    expect(attempts).toBe(1);
    down = false;
    now += 31_000;
    await expect(service.beginLogin()).resolves.toHaveProperty("authorizationUrl");
    expect(attempts).toBe(2);
  });

  it("reports a 4xx from the token endpoint as a failed exchange without the IdP's description", async () => {
    const provider = await MockOidcProvider.create({ clientSecret: "s3cret" });
    const service = new OidcService(noStore, settingsFor(provider), {
      flowKey: crypto.randomBytes(32),
      fetch: async (input, init) => {
        if (input === provider.discovery.token_endpoint) {
          return Response.json({ error: "invalid_client", error_description: "secret s3cret is wrong for user@example.com" }, { status: 401 });
        }
        return await provider.fetch(input, init);
      }
    });
    const begun = await service.beginLogin();
    const callback = new URL(provider.authorize(begun.authorizationUrl));
    const error = await service
      .completeLogin({ query: Object.fromEntries(callback.searchParams), flowCookie: begun.flowCookie })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "token_exchange_failed" });
    expect((error as Error).message).toContain("HTTP 401");
    expect((error as Error).message).toContain("error=invalid_client");
    expect((error as Error).message).not.toMatch(/s3cret|user@example.com|error_description/);
    expect(oidcUserErrorCode(error)).toBe("oidc_failed");
  });

  it("applies the optional email-domain and group allow-lists", () => {
    const check = (overrides: Partial<OidcSettings>, profile: { email?: string; emailVerified: boolean; groups: string[] }) => {
      const service = new OidcService(noStore, { ...settingsFor({ issuer: "https://idp", clientId: "c" } as MockOidcProvider), ...overrides }, {
        flowKey: crypto.randomBytes(32)
      });
      try {
        service.assertLoginAllowed({ identityKey: "https://idp#sub-1", ...profile });
        return "ok";
      } catch (error) {
        return (error as OidcError).code;
      }
    };
    const user = { email: "ann@example.com", emailVerified: true, groups: ["eng"] };
    expect(check({}, user)).toBe("ok");
    expect(check({ allowedEmailDomains: ["example.com"] }, user)).toBe("ok");
    expect(check({ allowedEmailDomains: ["example.org"] }, user)).toBe("not_allowed");
    // Exact domain: a subdomain or a look-alike suffix does not match.
    expect(check({ allowedEmailDomains: ["example.com"] }, { ...user, email: "ann@eu.example.com" })).toBe("not_allowed");
    expect(check({ allowedEmailDomains: ["example.com"] }, { ...user, email: "ann@badexample.com" })).toBe("not_allowed");
    // The domain must come from a trusted email.
    expect(check({ allowedEmailDomains: ["example.com"] }, { ...user, emailVerified: false })).toBe("not_allowed");
    expect(check({ allowedEmailDomains: ["example.com"], requireEmailVerified: false }, { ...user, emailVerified: false })).toBe("ok");
    expect(check({ allowedEmailDomains: ["example.com"] }, { ...user, email: undefined })).toBe("not_allowed");
    expect(check({ allowedGroups: ["eng", "ops"] }, user)).toBe("ok");
    expect(check({ allowedGroups: ["ops"] }, user)).toBe("not_allowed");
    expect(check({ allowedGroups: ["ENG"] }, user)).toBe("not_allowed");
    expect(check({ allowedEmailDomains: ["example.com"], allowedGroups: ["ops"] }, user)).toBe("not_allowed");
    expect(oidcUserErrorCode(new OidcError("not_allowed", "x"))).toBe("oidc_not_allowed");
  });

  it("refuses a discovery document whose issuer differs from OIDC_ISSUER", async () => {
    const provider = await MockOidcProvider.create();
    const service = new OidcService(noStore, settingsFor(provider, { issuer: `${provider.issuer}/` }), {
      flowKey: crypto.randomBytes(32),
      fetch: provider.fetch
    });
    await expect(service.beginLogin()).rejects.toMatchObject({ code: "discovery_failed" });
  });

  it("caches discovery", async () => {
    const provider = await MockOidcProvider.create();
    let discoveryFetches = 0;
    const service = new OidcService(noStore, settingsFor(provider), {
      flowKey: crypto.randomBytes(32),
      fetch: async (input, init) => {
        if (input.endsWith("/.well-known/openid-configuration")) discoveryFetches += 1;
        return await provider.fetch(input, init);
      }
    });
    await service.beginLogin();
    await service.beginLogin();
    expect(discoveryFetches).toBe(1);
  });
});

describe("OIDC helpers", () => {
  it("extracts groups from arrays, comma strings and dotted paths", () => {
    expect(extractGroups({ groups: ["a", "b", 3] }, "groups")).toEqual(["a", "b"]);
    expect(extractGroups({ groups: "a, b" }, "groups")).toEqual(["a", "b"]);
    expect(extractGroups({ realm_access: { roles: ["admin-group"] } }, "realm_access.roles")).toEqual(["admin-group"]);
    expect(extractGroups({ "https://example.com/groups": ["x"] }, "https://example.com/groups")).toEqual(["x"]);
    expect(extractGroups({}, "groups")).toEqual([]);
  });

  it("scopes the stored identity to the issuer", () => {
    expect(oidcIdentitySubject("https://a.example/realms/x", "1")).not.toBe(oidcIdentitySubject("https://b.example/realms/x", "1"));
    expect(oidcIdentitySubject("https://a.example", "1")).toBe("https://a.example#1");
  });

  it("maps errors to short user-facing codes", () => {
    expect(oidcUserErrorCode(new OidcError("state_mismatch", "x"))).toBe("oidc_state");
    expect(oidcUserErrorCode(new OidcError("email_not_verified", "x"))).toBe("oidc_email");
    expect(oidcUserErrorCode(new OidcError("invalid_id_token", "x"))).toBe("oidc_failed");
    expect(oidcUserErrorCode(new Error("boom"))).toBe("oidc_failed");
  });
});

describe("OIDC configuration", () => {
  const base = { SECRET_MASTER_KEY_BASE64: crypto.randomBytes(32).toString("base64") };

  it("is off and reads nothing by default", () => {
    const config = parseConfig(base);
    expect(config.OIDC_ENABLED).toBeUndefined();
    expect(resolveOidcSettings(config)).toBeNull();
    expect(resolveOidcSettings(parseConfig({ ...base, OIDC_ENABLED: "", OIDC_ISSUER: "not a url" }))).toBeNull();
  });

  it("applies defaults when enabled", () => {
    const settings = resolveOidcSettings(
      parseConfig({ ...base, OIDC_ENABLED: "true", OIDC_ISSUER: "https://idp.example.com/realms/x", OIDC_CLIENT_ID: "l2m" })
    );
    expect(settings).toEqual({
      issuer: "https://idp.example.com/realms/x",
      clientId: "l2m",
      clientSecret: undefined,
      redirectUrl: "http://localhost:5173/api/auth/oidc/callback",
      scopes: "openid email profile",
      groupsClaim: "groups",
      requireEmailVerified: true,
      postLoginUrl: "http://localhost:5173/",
      allowedEmailDomains: [],
      allowedGroups: []
    });
  });

  it("fails fast with a clear message, never echoing the client secret", () => {
    const enabled = { ...base, OIDC_ENABLED: "true", OIDC_CLIENT_SECRET: "top-secret-value" };
    expect(() => parseConfig(enabled)).toThrow(/OIDC_ISSUER is required/);
    expect(() => parseConfig({ ...enabled, OIDC_ISSUER: "http://idp.example.com" })).toThrow(/https/);
    expect(() => parseConfig({ ...enabled, OIDC_ISSUER: "https://idp.example.com" })).toThrow(/OIDC_CLIENT_ID is required/);
    expect(() =>
      parseConfig({ ...enabled, OIDC_ISSUER: "https://idp.example.com", OIDC_CLIENT_ID: "c", OIDC_SCOPES: "email profile" })
    ).toThrow(/must include openid/);
    try {
      parseConfig({ ...enabled, OIDC_ISSUER: "ftp://x" });
    } catch (error) {
      expect(String(error)).not.toContain("top-secret-value");
    }
    const ok = { ...enabled, OIDC_ISSUER: "https://idp.example.com", OIDC_CLIENT_ID: "c" };
    expect(() => parseConfig({ ...enabled, OIDC_ISSUER: "https://idp.example.com/#", OIDC_CLIENT_ID: "c" })).toThrow(/fragment/);
    // The redirect URL must be the API callback route, over https unless on loopback.
    expect(() => parseConfig({ ...ok, OIDC_REDIRECT_URL: "https://l2m.example.com/sso/callback" })).toThrow(/\/api\/auth\/oidc\/callback/);
    expect(() => parseConfig({ ...ok, OIDC_REDIRECT_URL: "http://l2m.example.com/api/auth/oidc/callback" })).toThrow(/https/);
    expect(() => parseConfig({ ...ok, OIDC_REDIRECT_URL: "https://l2m.example.com/api/auth/oidc/callback?x=1" })).toThrow(/query/);
    expect(() => parseConfig({ ...ok, OIDC_REDIRECT_URL: "/api/auth/oidc/callback" })).toThrow(/absolute/);
    expect(() => parseConfig({ ...ok, WEB_ORIGIN: "http://l2m.example.com" })).toThrow(/OIDC_REDIRECT_URL must use https/);
    expect(resolveOidcSettings(parseConfig({ ...ok, OIDC_REDIRECT_URL: "https://l2m.example.com/api/auth/oidc/callback" }))?.redirectUrl).toBe(
      "https://l2m.example.com/api/auth/oidc/callback"
    );
    expect(resolveOidcSettings(parseConfig({ ...ok, OIDC_REDIRECT_URL: "http://127.0.0.1:4000/api/auth/oidc/callback" }))?.redirectUrl).toBe(
      "http://127.0.0.1:4000/api/auth/oidc/callback"
    );
    // Allow-lists: trimmed, deduplicated, domains lowercased (a leading @ is accepted), bad domains refused.
    const lists = resolveOidcSettings(
      parseConfig({ ...ok, OIDC_ALLOWED_EMAIL_DOMAINS: " Example.com, @corp.example.org ,example.com", OIDC_ALLOWED_GROUPS: "l2m-users, admins" })
    );
    expect(lists?.allowedEmailDomains).toEqual(["example.com", "corp.example.org"]);
    expect(lists?.allowedGroups).toEqual(["l2m-users", "admins"]);
    expect(() => parseConfig({ ...ok, OIDC_ALLOWED_EMAIL_DOMAINS: "*.example.com" })).toThrow(/OIDC_ALLOWED_EMAIL_DOMAINS/);
    // Plain http is allowed only on loopback.
    expect(resolveOidcSettings(parseConfig({ ...enabled, OIDC_ISSUER: "http://localhost:8080/realms/dev", OIDC_CLIENT_ID: "c" }))?.issuer).toBe(
      "http://localhost:8080/realms/dev"
    );
  });
});
