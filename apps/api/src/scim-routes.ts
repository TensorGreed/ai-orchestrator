/**
 * 13.2 — SCIM 2.0 service provider endpoints (RFC 7644), registered only with SCIM_ENABLED=true:
 *
 *   GET    /scim/v2/ServiceProviderConfig
 *   GET    /scim/v2/ResourceTypes[/:id]
 *   GET    /scim/v2/Schemas[/:id]
 *   GET    /scim/v2/Users            filter (userName / externalId / id / emails.value eq), startIndex, count
 *   POST   /scim/v2/Users
 *   GET    /scim/v2/Users/:id
 *   PUT    /scim/v2/Users/:id
 *   PATCH  /scim/v2/Users/:id
 *   DELETE /scim/v2/Users/:id        deprovisions: disables the account, ends its sessions, revokes its API keys
 *   GET    /scim/v2/Groups           filter (displayName / externalId / id / members.value eq), startIndex, count
 *   POST   /scim/v2/Groups
 *   GET    /scim/v2/Groups/:id
 *   PUT    /scim/v2/Groups/:id
 *   PATCH  /scim/v2/Groups/:id
 *   DELETE /scim/v2/Groups/:id
 *
 * Every route needs a SCIM token (`Authorization: Bearer scim_…`, made by an admin under /api/scim/tokens); nothing
 * else (a session, an API key) is accepted here, and a SCIM token is accepted nowhere else. Bodies may be
 * `application/scim+json` or `application/json`; answers are `application/scim+json`, errors in the SCIM error format.
 * The routes live in their own scope, so the body parser and error handler below change no other route.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { SCIM_BASE_PATH } from "@ai-orchestrator/shared";
import type { ScimGroupRecord, ScimTokenRecord, ScimUserView } from "./db/scim-store.js";
import {
  groupDraftFromResource,
  parsePatchBody,
  parseScimGroupFilter,
  parseScimPage,
  parseScimUserFilter,
  SCIM_CONTENT_TYPE,
  SCIM_MAX_PAGE_SIZE,
  SCIM_SCHEMA_ENTERPRISE_USER,
  SCIM_SCHEMA_GROUP,
  SCIM_SCHEMA_LIST,
  SCIM_SCHEMA_RESOURCE_TYPE,
  SCIM_SCHEMA_SCHEMA,
  SCIM_SCHEMA_SERVICE_PROVIDER_CONFIG,
  SCIM_SCHEMA_USER,
  ScimError,
  scimErrorBody,
  userDraftFromResource
} from "./services/scim-protocol.js";
import type { ScimActor, ScimGroupView, ScimProvisioningService } from "./services/scim-provisioning-service.js";
import type { ScimTokenService } from "./services/scim-token-service.js";

export interface ScimRoutesDeps {
  app: FastifyInstance;
  tokens: ScimTokenService;
  provisioning: ScimProvisioningService;
  /** APP_PUBLIC_URL: resource locations are absolute when it is set, else paths. */
  publicUrl?: string | null;
  /** Records a refused SCIM token (sampled by the caller). */
  onRefused?: (request: FastifyRequest, reason: "missing" | "invalid") => Promise<void>;
}

const tokenOfRequest = new WeakMap<object, ScimTokenRecord>();

function bearer(request: FastifyRequest): string | null {
  const raw = request.headers.authorization;
  const value = typeof raw === "string" ? raw : "";
  const match = /^Bearer\s+(\S+)\s*$/i.exec(value);
  return match ? match[1]! : null;
}

function sendScim(reply: FastifyReply, status: number, body: unknown): FastifyReply {
  return reply.code(status).header("content-type", `${SCIM_CONTENT_TYPE}; charset=utf-8`).send(body);
}

function sendError(reply: FastifyReply, error: ScimError): FastifyReply {
  if (error.status === 401) reply.header("www-authenticate", 'Bearer realm="scim"');
  return sendScim(reply, error.status, scimErrorBody(error.status, error.detail, error.scimType));
}

function actorOf(request: FastifyRequest): ScimActor {
  const token = tokenOfRequest.get(request);
  const userAgent = request.headers["user-agent"];
  return {
    tokenId: token?.id ?? "",
    tokenName: token?.name ?? "",
    ipAddress: request.ip ?? null,
    userAgent: typeof userAgent === "string" ? userAgent.slice(0, 512) : null
  };
}

export function registerScimRoutes(deps: ScimRoutesDeps): void {
  const { app, tokens, provisioning } = deps;
  const base = `${(deps.publicUrl ?? "").replace(/\/+$/, "")}${SCIM_BASE_PATH}`;
  const location = (kind: "Users" | "Groups", id: string) => `${base}/${kind}/${encodeURIComponent(id)}`;

  const meta = (resourceType: "User" | "Group", id: string, created: string, lastModified: string) => ({
    resourceType,
    created,
    lastModified,
    location: location(resourceType === "User" ? "Users" : "Groups", id)
  });

  const userResource = (user: ScimUserView, groups: readonly ScimGroupRecord[]) => ({
    schemas: [SCIM_SCHEMA_USER],
    id: user.userId,
    ...(user.externalId ? { externalId: user.externalId } : {}),
    userName: user.userName,
    ...(user.givenName || user.familyName
      ? {
          name: {
            ...(user.givenName ? { givenName: user.givenName } : {}),
            ...(user.familyName ? { familyName: user.familyName } : {}),
            formatted: [user.givenName, user.familyName].filter(Boolean).join(" ")
          }
        }
      : {}),
    ...(user.displayName ? { displayName: user.displayName } : {}),
    emails: [{ value: user.email, type: "work", primary: true }],
    active: !user.disabledAt,
    groups: groups.map((group) => ({ value: group.id, display: group.displayName, $ref: location("Groups", group.id) })),
    meta: meta("User", user.userId, user.createdAt, user.updatedAt)
  });

  const groupResource = (group: ScimGroupRecord, members: ScimGroupView["members"] | null) => ({
    schemas: [SCIM_SCHEMA_GROUP],
    id: group.id,
    ...(group.externalId ? { externalId: group.externalId } : {}),
    displayName: group.displayName,
    ...(members ? { members: members.map((member) => ({ value: member.userId, display: member.userName, $ref: location("Users", member.userId) })) } : {}),
    meta: meta("Group", group.id, group.createdAt, group.updatedAt)
  });

  /** `excludedAttributes=members` (or `attributes` without members) leaves the member lists out of group answers. */
  const wantsMembers = (query: Record<string, unknown>): boolean => {
    const list = (value: unknown) => (typeof value === "string" ? value.split(",").map((entry) => entry.trim().toLowerCase()) : []);
    if (list(query.excludedAttributes).some((name) => name === "members" || name.endsWith(":members"))) return false;
    const attributes = list(query.attributes);
    if (attributes.length > 0 && !attributes.some((name) => name === "members" || name.startsWith("members.") || name.endsWith(":members"))) return false;
    return true;
  };

  const listResponse = (resources: unknown[], total: number, startIndex: number) => ({
    schemas: [SCIM_SCHEMA_LIST],
    totalResults: total,
    startIndex,
    itemsPerPage: resources.length,
    Resources: resources
  });

  app.register(
    async (scope) => {
      scope.addContentTypeParser(SCIM_CONTENT_TYPE, { parseAs: "string" }, (_request, body, done) => {
        const text = typeof body === "string" ? body : body.toString("utf8");
        if (text.trim() === "") {
          done(null, undefined);
          return;
        }
        try {
          done(null, JSON.parse(text));
        } catch {
          done(new ScimError(400, "The request body is not valid JSON", "invalidSyntax"), undefined);
        }
      });

      scope.setErrorHandler(async (error, request, reply) => {
        if (error instanceof ScimError) return sendError(reply, error);
        const statusCode = typeof (error as { statusCode?: unknown }).statusCode === "number" ? Number((error as { statusCode: number }).statusCode) : 500;
        if (statusCode === 413) return sendError(reply, new ScimError(413, "The request body is too large"));
        if (statusCode === 415) return sendError(reply, new ScimError(415, `Send ${SCIM_CONTENT_TYPE} or application/json`));
        if (statusCode >= 400 && statusCode < 500) return sendError(reply, new ScimError(400, "The request is not valid", "invalidSyntax"));
        request.log.error({ err: error }, "SCIM request failed");
        return sendError(reply, new ScimError(500, "Internal error"));
      });

      scope.setNotFoundHandler(async (_request, reply) => sendError(reply, new ScimError(404, "Unknown SCIM endpoint")));

      // Every SCIM route needs a live SCIM token.
      scope.addHook("onRequest", async (request, reply) => {
        const value = bearer(request);
        const token = value ? await tokens.verify(value) : null;
        if (!token) {
          await deps.onRefused?.(request, value ? "invalid" : "missing").catch(() => undefined);
          return sendError(reply, new ScimError(401, value ? "The SCIM token is not valid" : "A SCIM bearer token is required"));
        }
        tokenOfRequest.set(request, token);
      });

      // ---- Discovery -------------------------------------------------------

      const serviceProviderConfig = () => ({
        schemas: [SCIM_SCHEMA_SERVICE_PROVIDER_CONFIG],
        documentationUri: "https://lsquarem.com/docs/security/scim",
        patch: { supported: true },
        bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
        filter: { supported: true, maxResults: SCIM_MAX_PAGE_SIZE },
        changePassword: { supported: false },
        sort: { supported: false },
        etag: { supported: false },
        authenticationSchemes: [
          { type: "oauthbearertoken", name: "Bearer token", description: "A SCIM token made by an admin in Settings", primary: true }
        ],
        meta: { resourceType: "ServiceProviderConfig", location: `${base}/ServiceProviderConfig` }
      });

      const resourceTypes = () => [
        {
          schemas: [SCIM_SCHEMA_RESOURCE_TYPE],
          id: "User",
          name: "User",
          endpoint: "/Users",
          schema: SCIM_SCHEMA_USER,
          schemaExtensions: [{ schema: SCIM_SCHEMA_ENTERPRISE_USER, required: false }],
          meta: { resourceType: "ResourceType", location: `${base}/ResourceTypes/User` }
        },
        {
          schemas: [SCIM_SCHEMA_RESOURCE_TYPE],
          id: "Group",
          name: "Group",
          endpoint: "/Groups",
          schema: SCIM_SCHEMA_GROUP,
          meta: { resourceType: "ResourceType", location: `${base}/ResourceTypes/Group` }
        }
      ];

      const attribute = (name: string, type: string, extra: Record<string, unknown> = {}) => ({
        name,
        type,
        multiValued: false,
        required: false,
        caseExact: false,
        mutability: "readWrite",
        returned: "default",
        uniqueness: "none",
        ...extra
      });

      const schemas = () => [
        {
          schemas: [SCIM_SCHEMA_SCHEMA],
          id: SCIM_SCHEMA_USER,
          name: "User",
          description: "User account",
          attributes: [
            attribute("userName", "string", { required: true, uniqueness: "server" }),
            attribute("externalId", "string", { caseExact: true }),
            attribute("displayName", "string"),
            attribute("name", "complex", {
              subAttributes: [attribute("givenName", "string"), attribute("familyName", "string"), attribute("formatted", "string", { mutability: "readOnly" })]
            }),
            attribute("emails", "complex", {
              multiValued: true,
              subAttributes: [attribute("value", "string"), attribute("type", "string"), attribute("primary", "boolean")]
            }),
            attribute("active", "boolean"),
            attribute("groups", "complex", {
              multiValued: true,
              mutability: "readOnly",
              subAttributes: [attribute("value", "string", { mutability: "readOnly" }), attribute("display", "string", { mutability: "readOnly" })]
            })
          ],
          meta: { resourceType: "Schema", location: `${base}/Schemas/${SCIM_SCHEMA_USER}` }
        },
        {
          schemas: [SCIM_SCHEMA_SCHEMA],
          id: SCIM_SCHEMA_GROUP,
          name: "Group",
          description: "Group",
          attributes: [
            attribute("displayName", "string", { required: true, uniqueness: "server" }),
            attribute("externalId", "string", { caseExact: true }),
            attribute("members", "complex", {
              multiValued: true,
              subAttributes: [attribute("value", "string", { mutability: "immutable" }), attribute("display", "string", { mutability: "readOnly" })]
            })
          ],
          meta: { resourceType: "Schema", location: `${base}/Schemas/${SCIM_SCHEMA_GROUP}` }
        }
      ];

      scope.get("/ServiceProviderConfig", async (_request, reply) => sendScim(reply, 200, serviceProviderConfig()));
      scope.get("/ResourceTypes", async (_request, reply) => {
        const types = resourceTypes();
        return sendScim(reply, 200, listResponse(types, types.length, 1));
      });
      scope.get<{ Params: { id: string } }>("/ResourceTypes/:id", async (request, reply) => {
        const found = resourceTypes().find((type) => type.id === request.params.id);
        if (!found) throw new ScimError(404, `Resource type ${request.params.id} not found`);
        return sendScim(reply, 200, found);
      });
      scope.get("/Schemas", async (_request, reply) => {
        const list = schemas();
        return sendScim(reply, 200, listResponse(list, list.length, 1));
      });
      scope.get<{ Params: { id: string } }>("/Schemas/:id", async (request, reply) => {
        const found = schemas().find((schema) => schema.id === request.params.id);
        if (!found) throw new ScimError(404, `Schema ${request.params.id} not found`);
        return sendScim(reply, 200, found);
      });

      // ---- Users -----------------------------------------------------------

      const userBody = async (user: ScimUserView) => userResource(user, await provisioning.groupsOfUser(user.userId));

      scope.get<{ Querystring: Record<string, unknown> }>("/Users", async (request, reply) => {
        const query = request.query ?? {};
        const filter = parseScimUserFilter(typeof query.filter === "string" ? query.filter : undefined);
        const page = parseScimPage(query);
        const result = await provisioning.listUsers(filter, page.offset, page.limit);
        const resources = [];
        for (const user of result.items) resources.push(await userBody(user));
        return sendScim(reply, 200, listResponse(resources, result.total, page.startIndex));
      });

      scope.post<{ Body: unknown }>("/Users", async (request, reply) => {
        const created = await provisioning.createUser(actorOf(request), userDraftFromResource(request.body));
        reply.header("location", location("Users", created.userId));
        return sendScim(reply, 201, await userBody(created));
      });

      scope.get<{ Params: { id: string } }>("/Users/:id", async (request, reply) => sendScim(reply, 200, await userBody(await provisioning.getUser(request.params.id))));

      scope.put<{ Params: { id: string }; Body: unknown }>("/Users/:id", async (request, reply) => {
        const updated = await provisioning.replaceUser(actorOf(request), request.params.id, userDraftFromResource(request.body));
        return sendScim(reply, 200, await userBody(updated));
      });

      scope.patch<{ Params: { id: string }; Body: unknown }>("/Users/:id", async (request, reply) => {
        const updated = await provisioning.patchUser(actorOf(request), request.params.id, parsePatchBody(request.body));
        return sendScim(reply, 200, await userBody(updated));
      });

      scope.delete<{ Params: { id: string } }>("/Users/:id", async (request, reply) => {
        await provisioning.deleteUser(actorOf(request), request.params.id);
        return reply.code(204).send();
      });

      // ---- Groups ----------------------------------------------------------

      scope.get<{ Querystring: Record<string, unknown> }>("/Groups", async (request, reply) => {
        const query = request.query ?? {};
        const filter = parseScimGroupFilter(typeof query.filter === "string" ? query.filter : undefined);
        const page = parseScimPage(query);
        const result = await provisioning.listGroups(filter, page.offset, page.limit);
        const members = wantsMembers(query);
        const resources = [];
        for (const group of result.items) resources.push(groupResource(group, members ? await provisioning.membersOf(group.id) : null));
        return sendScim(reply, 200, listResponse(resources, result.total, page.startIndex));
      });

      scope.post<{ Body: unknown }>("/Groups", async (request, reply) => {
        const created = await provisioning.createGroup(actorOf(request), groupDraftFromResource(request.body));
        reply.header("location", location("Groups", created.id));
        return sendScim(reply, 201, groupResource(created, created.members));
      });

      scope.get<{ Params: { id: string }; Querystring: Record<string, unknown> }>("/Groups/:id", async (request, reply) => {
        const group = await provisioning.getGroup(request.params.id);
        return sendScim(reply, 200, groupResource(group, wantsMembers(request.query ?? {}) ? group.members : null));
      });

      scope.put<{ Params: { id: string }; Body: unknown }>("/Groups/:id", async (request, reply) => {
        const updated = await provisioning.replaceGroup(actorOf(request), request.params.id, groupDraftFromResource(request.body));
        return sendScim(reply, 200, groupResource(updated, updated.members));
      });

      scope.patch<{ Params: { id: string }; Body: unknown; Querystring: Record<string, unknown> }>("/Groups/:id", async (request, reply) => {
        const updated = await provisioning.patchGroup(actorOf(request), request.params.id, parsePatchBody(request.body));
        // A membership PATCH may be answered with 204 (RFC 7644 §3.5.2); the group is returned when asked for.
        if (request.query?.attributes === undefined && request.query?.excludedAttributes === undefined) return reply.code(204).send();
        return sendScim(reply, 200, groupResource(updated, wantsMembers(request.query ?? {}) ? updated.members : null));
      });

      scope.delete<{ Params: { id: string } }>("/Groups/:id", async (request, reply) => {
        await provisioning.deleteGroup(actorOf(request), request.params.id);
        return reply.code(204).send();
      });
    },
    { prefix: SCIM_BASE_PATH }
  );
}

