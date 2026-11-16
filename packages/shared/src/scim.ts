/**
 * 13.2 — SCIM 2.0 provisioning: the admin API's shapes, shared by the API (/api/scim) and the studio (Settings →
 * Provisioning). The SCIM protocol itself is served under SCIM_BASE_PATH when SCIM_ENABLED=true.
 */
import { z } from "zod";

/** Where the SCIM 2.0 endpoints are served. */
export const SCIM_BASE_PATH = "/scim/v2";

/** The `provider` the admin's group mappings for SCIM groups are stored under (with the SSO group mappings). */
export const SCIM_MAPPING_PROVIDER = "scim" as const;

/** The longest lifetime a SCIM token may be given, in days (0 or unset = no expiry). */
export const SCIM_TOKEN_MAX_EXPIRY_DAYS = 3650;

export const scimTokenCreateBodySchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    expiresInDays: z.number().int().min(0).max(SCIM_TOKEN_MAX_EXPIRY_DAYS).optional()
  })
  .strict();

export type ScimTokenCreateBody = z.infer<typeof scimTokenCreateBodySchema>;

/** A SCIM token as the admin API lists it (never the secret, which is shown once). */
export interface ScimTokenSummary {
  id: string;
  name: string;
  tokenPrefix: string;
  createdBy: string | null;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  supersededBy: string | null;
  active: boolean;
}

/** A provisioned group, with what it grants. */
export interface ScimGroupSummary {
  id: string;
  displayName: string;
  externalId: string | null;
  memberCount: number;
  /** Mappings (provider `scim`) that name this group; empty = the group grants nothing. */
  mappingIds: string[];
  createdAt: string;
  updatedAt: string;
}

/** GET /api/scim */
export interface ScimSettingsView {
  enabled: boolean;
  /** The SCIM base URL to give the identity provider (absolute when APP_PUBLIC_URL is set). */
  baseUrl: string;
  tokens: ScimTokenSummary[];
  provisionedUsers: number;
  disabledUsers: number;
  groups: number;
}
