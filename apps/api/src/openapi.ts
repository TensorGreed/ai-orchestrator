/**
 * Static OpenAPI 3.0 specification for the AI Orchestrator REST API.
 * Generated as part of Phase 7.3 API Completeness.
 */

export const openApiSpec = {
  openapi: "3.0.3",
  info: {
    title: "AI Orchestrator API",
    version: "1.0.0",
    description:
      "REST API for the AI Orchestrator visual workflow builder and execution engine. " +
      "Provides endpoints for workflow CRUD, execution, secrets management, " +
      "authentication, project organization, and observability."
  },
  servers: [{ url: "/", description: "Current instance" }],
  tags: [
    { name: "Auth", description: "Authentication, sessions, MFA, API keys, SSO" },
    { name: "Workflows", description: "Workflow CRUD, import/export, validation, execution" },
    { name: "Executions", description: "Execution history, retry, cancel" },
    { name: "Approvals", description: "Human-in-the-loop approval gates" },
    { name: "Projects", description: "Project and folder management" },
    { name: "Secrets", description: "Credential/secret management" },
    { name: "Variables", description: "Project-scoped variable management" },
    { name: "Providers", description: "LLM provider testing and model discovery" },
    { name: "MCP", description: "MCP tool discovery" },
    { name: "Guard", description: "Guard profiles, bindings, verdict events and Security page counts" },
    { name: "Audit bundles", description: "Signed run manifests, audit bundle export and the deployment signing keys" },
    { name: "Evals", description: "Eval datasets, golden sets, eval runs, replay jobs and their per-case scores and diffs" },
    { name: "Git", description: "Git source control sync" },
    { name: "Audit", description: "Audit log and export" },
    { name: "Observability", description: "Health, metrics, traces, SLOs" },
    { name: "RBAC", description: "Custom roles, project members, sharing" },
    { name: "Triggers", description: "Webhook and trigger endpoints" },
    { name: "Queue", description: "Execution queue management" },
    { name: "LogStreaming", description: "Log streaming destinations" },
    { name: "ExternalSecrets", description: "External secret provider management" }
  ],
  paths: {
    // ── Observability ──────────────────────────────────────────────────────
    "/health": {
      get: {
        tags: ["Observability"],
        summary: "Health check",
        responses: { "200": { description: "Server is healthy", content: { "application/json": { schema: { type: "object", properties: { status: { type: "string" }, uptime: { type: "number" } } } } } } }
      }
    },
    "/metrics": {
      get: {
        tags: ["Observability"],
        summary: "Prometheus-compatible metrics",
        responses: { "200": { description: "Metrics in text format", content: { "text/plain": { schema: { type: "string" } } } } }
      }
    },
    "/api/observability": {
      get: {
        tags: ["Observability"],
        summary: "Observability dashboard data",
        responses: { "200": { description: "Observability metrics" } }
      }
    },
    "/api/observability/slo": {
      get: {
        tags: ["Observability"],
        summary: "SLO status",
        responses: { "200": { description: "SLO data" } }
      }
    },
    "/api/observability/traces": {
      get: {
        tags: ["Observability"],
        summary: "List recent traces",
        parameters: [
          { name: "limit", in: "query", schema: { type: "integer" }, description: "Max traces to return" }
        ],
        responses: { "200": { description: "Trace list" } }
      }
    },
    "/api/ha/status": {
      get: {
        tags: ["Observability"],
        summary: "High-availability / leader election status",
        responses: { "200": { description: "HA status" } }
      }
    },

    // ── Auth ───────────────────────────────────────────────────────────────
    "/api/auth/register": {
      post: {
        tags: ["Auth"],
        summary: "Register a new user",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["email", "password"],
                properties: {
                  email: { type: "string", format: "email" },
                  password: { type: "string", minLength: 8 },
                  role: { type: "string", enum: ["admin", "builder", "operator", "viewer"] }
                }
              }
            }
          }
        },
        responses: {
          "200": { description: "User created", content: { "application/json": { schema: { type: "object", properties: { user: { $ref: "#/components/schemas/SafeUser" } } } } } },
          "400": { description: "Validation error" },
          "403": { description: "Insufficient permissions" }
        }
      }
    },
    "/api/auth/login": {
      post: {
        tags: ["Auth"],
        summary: "Log in with email and password",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["email", "password"],
                properties: {
                  email: { type: "string", format: "email" },
                  password: { type: "string" }
                }
              }
            }
          }
        },
        responses: {
          "200": { description: "Login successful (session cookie set) or MFA challenge issued" },
          "401": { description: "Invalid credentials" }
        }
      }
    },
    "/api/auth/login/mfa": {
      post: {
        tags: ["Auth"],
        summary: "Complete MFA challenge during login (password or SSO sign-in)",
        description:
          "An SSO sign-in that ends in the TOTP step (SSO_MFA=idp_or_local) carries its challenge in the HttpOnly l2m_sso_mfa cookie; `challenge` may then be omitted.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["code"],
                properties: {
                  challenge: { type: "string", description: "The mfaChallenge from the login response; defaults to the l2m_sso_mfa cookie" },
                  code: { type: "string" }
                }
              }
            }
          }
        },
        responses: {
          "200": { description: "MFA verified, session created" },
          "401": { description: "Invalid MFA code or expired challenge" }
        }
      }
    },
    "/api/auth/logout": {
      post: {
        tags: ["Auth"],
        summary: "Log out and revoke session",
        responses: { "200": { description: "Logged out" } }
      }
    },
    "/api/auth/me": {
      get: {
        tags: ["Auth"],
        summary: "Get current authenticated user info",
        responses: {
          "200": { description: "Current user, MFA status, project memberships" },
          "401": { description: "Not authenticated" }
        }
      }
    },
    "/api/auth/mfa/status": {
      get: {
        tags: ["Auth"],
        summary: "Get MFA enrollment status for current user",
        responses: { "200": { description: "MFA status" } }
      }
    },
    "/api/auth/mfa/enroll": {
      post: {
        tags: ["Auth"],
        summary: "Begin MFA TOTP enrollment",
        responses: {
          "200": { description: "TOTP secret, otpauth URL, and backup codes" },
          "409": { description: "MFA already enabled" }
        }
      }
    },
    "/api/auth/mfa/activate": {
      post: {
        tags: ["Auth"],
        summary: "Activate MFA with a TOTP code",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["code"], properties: { code: { type: "string" } } } } } },
        responses: {
          "200": { description: "MFA activated" },
          "401": { description: "Invalid code" }
        }
      }
    },
    "/api/auth/mfa/disable": {
      post: {
        tags: ["Auth"],
        summary: "Disable MFA for current user",
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { code: { type: "string" } } } } } },
        responses: { "200": { description: "MFA disabled" } }
      }
    },
    "/api/auth/api-keys": {
      get: {
        tags: ["Auth"],
        summary: "List API keys for current user (or all for admin)",
        responses: { "200": { description: "API key list" } }
      },
      post: {
        tags: ["Auth"],
        summary: "Create a new API key",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name"],
                properties: {
                  name: { type: "string" },
                  scopes: { type: "array", items: { type: "string" } },
                  expiresInDays: { type: "integer" }
                }
              }
            }
          }
        },
        responses: { "200": { description: "API key created (plaintext returned once)" } }
      }
    },
    "/api/auth/api-keys/{id}": {
      delete: {
        tags: ["Auth"],
        summary: "Revoke an API key",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "Key revoked" },
          "404": { description: "Key not found" }
        }
      }
    },
    "/api/auth/saml/metadata": {
      get: {
        tags: ["Auth"],
        summary: "Get SAML SSO metadata and configuration",
        responses: { "200": { description: "SAML metadata" } }
      }
    },
    "/api/auth/saml/login": {
      get: {
        tags: ["Auth"],
        summary: "Initiate SAML SSO login (redirects to IdP; with SAML_REQUIRE_IN_RESPONSE_TO also sets the l2m_saml_req cookie)",
        responses: { "302": { description: "Redirect to SAML IdP" }, "429": { description: "Auth rate limit reached (Retry-After)" } }
      }
    },
    "/api/auth/saml/callback": {
      post: {
        tags: ["Auth"],
        summary: "SAML SSO assertion callback (HTTP-POST binding form post, or JSON)",
        responses: {
          "200": {
            description:
              "JSON post: user authenticated via SAML ({ user, expiresAt, provisioned, mfaEnrollmentRequired? }), or { mfaChallenge } when the local TOTP step is required"
          },
          "302": { description: "Form post: redirect to the web app (with sso_error on failure, or sso_mfa=totp for the TOTP step)" },
          "401": { description: "JSON post: assertion refused (invalid, replayed, unsolicited under SAML_REQUIRE_IN_RESPONSE_TO), or code sso_mfa_required" },
          "403": { description: "JSON post: refused by SAML_ALLOWED_EMAIL_DOMAINS / SAML_ALLOWED_GROUPS (code saml_not_allowed)" },
          "429": { description: "Auth rate limit reached (Retry-After)" }
        }
      }
    },
    "/api/auth/oidc/metadata": {
      get: {
        tags: ["Auth"],
        summary: "OIDC SSO settings the login page needs (issuer, client id, login path); { enabled: false } when OIDC is off",
        responses: { "200": { description: "OIDC settings, or { enabled: false } when OIDC is off" } }
      }
    },
    "/api/auth/oidc/login": {
      get: {
        tags: ["Auth"],
        summary: "Start OIDC SSO login: sets a short-lived flow cookie and redirects to the IdP (Authorization Code + PKCE)",
        responses: { "302": { description: "Redirect to the IdP, or to the login page with sso_error" }, "404": { description: "OIDC is not enabled" } }
      }
    },
    "/api/auth/oidc/callback": {
      get: {
        tags: ["Auth"],
        summary: "OIDC SSO redirect target: validates state, PKCE and the ID token, then signs the user in",
        responses: {
          "302": { description: "Redirect to the web app, with sso_error on failure, or sso_mfa=totp for the TOTP step" },
          "404": { description: "OIDC is not enabled" }
        }
      }
    },
    "/api/auth/ldap/login": {
      post: {
        tags: ["Auth"],
        summary: "Log in via LDAP",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", required: ["email", "password"], properties: { email: { type: "string" }, password: { type: "string" } } } } }
        },
        responses: {
          "200": { description: "LDAP login successful" },
          "401": { description: "Invalid credentials" }
        }
      }
    },
    "/api/auth/sso/mappings": {
      get: {
        tags: ["Auth"],
        summary: "List SSO group-to-role mappings (admin only)",
        parameters: [{ name: "provider", in: "query", schema: { type: "string" } }],
        responses: { "200": { description: "SSO mappings" } }
      },
      post: {
        tags: ["Auth"],
        summary: "Create or update an SSO group-to-role mapping",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", required: ["provider", "groupName", "role"], properties: { provider: { type: "string", enum: ["saml", "ldap", "oidc"] }, groupName: { type: "string" }, role: { type: "string" }, projectId: { type: "string", nullable: true }, customRoleId: { type: "string", nullable: true } } } } }
        },
        responses: { "200": { description: "Mapping upserted" } }
      }
    },
    "/api/auth/sso/mappings/{id}": {
      delete: {
        tags: ["Auth"],
        summary: "Delete an SSO group-to-role mapping",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Mapping deleted" }, "404": { description: "Not found" } }
      }
    },

    // ── Workflows ──────────────────────────────────────────────────────────
    "/api/workflows": {
      get: {
        tags: ["Workflows"],
        summary: "List all workflows",
        parameters: [
          { name: "projectId", in: "query", schema: { type: "string" } },
          { name: "folderId", in: "query", schema: { type: "string" } },
          { name: "tag", in: "query", schema: { type: "string" } },
          { name: "search", in: "query", schema: { type: "string" } }
        ],
        responses: { "200": { description: "Workflow list" } }
      },
      post: {
        tags: ["Workflows"],
        summary: "Create a new workflow",
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/Workflow" } } } },
        responses: {
          "200": { description: "Workflow created" },
          "400": { description: "Validation error" }
        }
      }
    },
    "/api/workflows/{id}": {
      get: {
        tags: ["Workflows"],
        summary: "Get a workflow by ID",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Workflow object" }, "404": { description: "Not found" } }
      },
      put: {
        tags: ["Workflows"],
        summary: "Update a workflow",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: { required: true, content: { "application/json": { schema: { $ref: "#/components/schemas/Workflow" } } } },
        responses: { "200": { description: "Workflow updated" }, "400": { description: "Validation error" } }
      },
      delete: {
        tags: ["Workflows"],
        summary: "Delete a workflow",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Workflow deleted" }, "404": { description: "Not found" } }
      }
    },
    "/api/workflows/{id}/execute": {
      post: {
        tags: ["Workflows"],
        summary: "Execute a workflow synchronously",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  input: { type: "object" },
                  variables: { type: "object" },
                  system_prompt: { type: "string" },
                  user_prompt: { type: "string" },
                  sessionId: { type: "string" },
                  startNodeId: { type: "string" },
                  runMode: { type: "string", enum: ["full", "single_node"] },
                  usePinnedData: { type: "boolean" },
                  executionTimeoutMs: { type: "integer" },
                  record: { type: "boolean", description: "Record every MCP call of the run into a cassette (returned as mcpCassette)" }
                }
              }
            }
          }
        },
        responses: {
          "200": { description: "Execution result" },
          "400": { description: "Execution failed" },
          "404": { description: "Workflow not found" }
        }
      }
    },
    "/api/workflows/{id}/execute/stream": {
      post: {
        tags: ["Workflows"],
        summary: "Execute a workflow with SSE streaming",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "SSE stream of node_start, node_complete, llm_delta, node_progress (MCP progress notifications: nodeId, toolName, serverId, registryServerId, progress, total, percent, message, at), node_activity (what a running node is doing: nodeId, at, seq, kind resolved_input | llm_call | retry | agent_step | tool_call, plus workerNodeId for a Supervisor's worker), result events, plus a `: ping` comment every SSE_HEARTBEAT_INTERVAL_MS (15s by default) while nothing else is sent", content: { "text/event-stream": { schema: { type: "string" } } } },
          "404": { description: "Workflow not found" }
        }
      }
    },
    "/api/workflows/{id}/duplicate": {
      post: {
        tags: ["Workflows"],
        summary: "Duplicate a workflow",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["name"], properties: { name: { type: "string" }, id: { type: "string" } } } } } },
        responses: { "200": { description: "Duplicated workflow" } }
      }
    },
    "/api/workflows/import": {
      post: {
        tags: ["Workflows"],
        summary: "Import a workflow from JSON",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { json: { type: "string" }, workflow: { type: "object" } } } } } },
        responses: { "200": { description: "Imported workflow" }, "400": { description: "Import failed" } }
      }
    },
    "/api/workflows/{id}/export": {
      get: {
        tags: ["Workflows"],
        summary: "Export a workflow as JSON",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Exported JSON string" } }
      }
    },
    "/api/workflows/{id}/validate": {
      post: {
        tags: ["Workflows"],
        summary: "Validate a workflow graph",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Validation result with issues array" } }
      }
    },
    "/api/workflows/{id}/move": {
      post: {
        tags: ["Workflows"],
        summary: "Move a workflow between projects/folders or update tags",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { projectId: { type: "string" }, folderId: { type: "string", nullable: true }, tags: { type: "array", items: { type: "string" } } } } } } },
        responses: { "200": { description: "Updated workflow" } }
      }
    },
    "/api/workflows/{id}/variables": {
      get: {
        tags: ["Workflows"],
        summary: "Get workflow-level variables",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Workflow variables" } }
      },
      put: {
        tags: ["Workflows"],
        summary: "Set workflow-level variables",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Updated variables" } }
      }
    },
    "/api/workflows/{id}/pins": {
      get: {
        tags: ["Workflows"],
        summary: "Get pinned data for a workflow",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Pinned data map" } }
      }
    },
    "/api/workflows/{id}/pins/{nodeId}": {
      put: {
        tags: ["Workflows"],
        summary: "Pin data for a specific node",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "nodeId", in: "path", required: true, schema: { type: "string" } }
        ],
        responses: { "200": { description: "Pin set" } }
      },
      delete: {
        tags: ["Workflows"],
        summary: "Unpin data for a specific node",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "nodeId", in: "path", required: true, schema: { type: "string" } }
        ],
        responses: { "200": { description: "Pin removed" } }
      }
    },
    "/api/workflows/{id}/versions": {
      get: {
        tags: ["Workflows"],
        summary: "List version history for a workflow",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Version list" } }
      }
    },
    "/api/workflows/{id}/versions/{version}": {
      get: {
        tags: ["Workflows"],
        summary: "Get a specific workflow version snapshot",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "version", in: "path", required: true, schema: { type: "integer" } }
        ],
        responses: { "200": { description: "Version snapshot" }, "404": { description: "Version not found" } }
      }
    },
    "/api/workflows/{id}/versions/{version}/restore": {
      post: {
        tags: ["Workflows"],
        summary: "Restore a workflow to a previous version",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "version", in: "path", required: true, schema: { type: "integer" } }
        ],
        responses: { "200": { description: "Restored workflow" } }
      }
    },
    "/api/workflows/{id}/shares": {
      get: {
        tags: ["RBAC"],
        summary: "List cross-project shares for a workflow",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Share list" } }
      },
      post: {
        tags: ["RBAC"],
        summary: "Share a workflow with another project",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["projectId"], properties: { projectId: { type: "string" }, accessLevel: { type: "string", enum: ["read", "execute"] } } } } } },
        responses: { "200": { description: "Shared" } }
      }
    },
    "/api/workflows/{id}/shares/{projectId}": {
      delete: {
        tags: ["RBAC"],
        summary: "Remove a workflow share",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "projectId", in: "path", required: true, schema: { type: "string" } }
        ],
        responses: { "200": { description: "Share removed" } }
      }
    },
    "/api/workflows/{id}/enqueue": {
      post: {
        tags: ["Queue"],
        summary: "Enqueue a workflow execution",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { input: { type: "object" }, variables: { type: "object" }, systemPrompt: { type: "string" }, userPrompt: { type: "string" }, sessionId: { type: "string" }, priority: { type: "integer" } } } } } },
        responses: { "200": { description: "Queued execution with executionId" } }
      }
    },

    // ── Executions ─────────────────────────────────────────────────────────
    "/api/executions": {
      get: {
        tags: ["Executions"],
        summary: "List execution history",
        parameters: [
          { name: "page", in: "query", schema: { type: "integer" } },
          { name: "pageSize", in: "query", schema: { type: "integer" } },
          { name: "status", in: "query", schema: { type: "string" } },
          { name: "workflowId", in: "query", schema: { type: "string" } },
          { name: "triggerType", in: "query", schema: { type: "string" } },
          { name: "startedFrom", in: "query", schema: { type: "string", format: "date-time" } },
          { name: "startedTo", in: "query", schema: { type: "string", format: "date-time" } }
        ],
        responses: { "200": { description: "Paginated execution history" } }
      }
    },
    "/api/executions/{id}": {
      get: {
        tags: ["Executions"],
        summary: "Get a single execution by ID",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Execution details" }, "404": { description: "Not found" } }
      }
    },
    "/api/executions/{id}/retry": {
      post: {
        tags: ["Executions"],
        summary: "Retry a failed or canceled execution",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "Retry result" },
          "404": { description: "Execution not found" },
          "409": { description: "Execution is not retryable" }
        }
      }
    },
    "/api/executions/{id}/cancel": {
      post: {
        tags: ["Executions"],
        summary: "Cancel a running or waiting execution",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { reason: { type: "string" } } } } } },
        responses: {
          "200": { description: "Execution canceled" },
          "409": { description: "Execution is not cancelable" }
        }
      }
    },

    // ── Approvals ──────────────────────────────────────────────────────────
    "/api/approvals": {
      get: {
        tags: ["Approvals"],
        summary: "List approval requests of workflows the user can read",
        description:
          "Pending requests by default. Each item says whether the signed-in user may decide it (canDecide) and why not. Viewer or above; items are limited to projects the user can read.",
        parameters: [
          { name: "status", in: "query", required: false, schema: { type: "string", enum: ["pending", "decided", "all"] } },
          { name: "workflowId", in: "query", required: false, schema: { type: "string" } },
          { name: "executionId", in: "query", required: false, schema: { type: "string" } },
          { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 500 } }
        ],
        responses: { "200": { description: "Approval requests" } }
      }
    },
    "/api/approvals/{id}/approve": {
      post: {
        tags: ["Approvals"],
        summary: "Approve the run paused as execution {id}",
        description:
          "Needs execute access to the workflow's project and must match the request's approvers; the person who started the run may not approve an Approval Gate unless it allows self-approval. With the execution queue in use the resume is queued (202).",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  reason: { type: "string", maxLength: 2000 },
                  edits: { type: "object", description: "Values for the gate's editable fields" },
                  requestId: { type: "string", description: "The request the approver saw; an older one is refused with 409" }
                }
              }
            }
          }
        },
        responses: {
          "200": { description: "Execution resumed (the run result)" },
          "202": { description: "Resume queued" },
          "400": { description: "Invalid edits, or the resumed run failed" },
          "403": { description: "Not an approver, self-approval, or no execute access" },
          "404": { description: "Approval not found" },
          "409": { description: "Already decided, or a newer request is waiting" }
        }
      }
    },
    "/api/approvals/{id}/reject": {
      post: {
        tags: ["Approvals"],
        summary: "Reject the run paused as execution {id}",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          content: {
            "application/json": {
              schema: { type: "object", properties: { reason: { type: "string", maxLength: 2000, description: "Required for Approval Gates and write-tool approvals" }, requestId: { type: "string" } } }
            }
          }
        },
        responses: {
          "200": { description: "Execution resumed with the rejection" },
          "202": { description: "Resume queued" },
          "400": { description: "Reason missing, or the resumed run failed" },
          "403": { description: "Not an approver, self-approval, or no execute access" },
          "404": { description: "Approval not found" },
          "409": { description: "Already decided" }
        }
      }
    },

    // ── Projects & Folders ─────────────────────────────────────────────────
    "/api/projects": {
      get: {
        tags: ["Projects"],
        summary: "List all projects",
        responses: { "200": { description: "Project list" } }
      },
      post: {
        tags: ["Projects"],
        summary: "Create a project",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["name"], properties: { id: { type: "string" }, name: { type: "string" }, description: { type: "string" } } } } } },
        responses: { "200": { description: "Project created" } }
      }
    },
    "/api/projects/{id}": {
      put: {
        tags: ["Projects"],
        summary: "Update a project",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Project updated" } }
      },
      delete: {
        tags: ["Projects"],
        summary: "Delete a project",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Project deleted" }, "404": { description: "Not found" } }
      }
    },
    "/api/projects/{id}/members": {
      get: {
        tags: ["RBAC"],
        summary: "List project members",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Member list" } }
      },
      post: {
        tags: ["RBAC"],
        summary: "Add a member to a project",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["userId", "role"], properties: { userId: { type: "string" }, role: { type: "string" }, customRoleId: { type: "string", nullable: true } } } } } },
        responses: { "200": { description: "Member added" } }
      }
    },
    "/api/projects/{id}/members/{userId}": {
      delete: {
        tags: ["RBAC"],
        summary: "Remove a member from a project",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "userId", in: "path", required: true, schema: { type: "string" } }
        ],
        responses: { "200": { description: "Member removed" } }
      }
    },
    "/api/folders": {
      get: {
        tags: ["Projects"],
        summary: "List folders",
        parameters: [{ name: "projectId", in: "query", schema: { type: "string" } }],
        responses: { "200": { description: "Folder list" } }
      },
      post: {
        tags: ["Projects"],
        summary: "Create a folder",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["name", "projectId"], properties: { id: { type: "string" }, name: { type: "string" }, parentId: { type: "string" }, projectId: { type: "string" } } } } } },
        responses: { "200": { description: "Folder created" } }
      }
    },
    "/api/folders/{id}": {
      put: {
        tags: ["Projects"],
        summary: "Update a folder",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Folder updated" } }
      },
      delete: {
        tags: ["Projects"],
        summary: "Delete a folder",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Folder deleted" } }
      }
    },

    // ── Secrets ─────────────────────────────────────────────────────────────
    "/api/secrets": {
      get: {
        tags: ["Secrets"],
        summary: "List secrets (metadata only, never raw values)",
        parameters: [{ name: "projectId", in: "query", schema: { type: "string" } }],
        responses: { "200": { description: "Secret metadata list" } }
      },
      post: {
        tags: ["Secrets"],
        summary: "Create a secret (local or external reference)",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name", "provider"],
                properties: {
                  name: { type: "string" },
                  provider: { type: "string" },
                  value: { type: "string", description: "Required for local secrets" },
                  projectId: { type: "string" },
                  externalProviderId: { type: "string" },
                  externalKey: { type: "string" }
                }
              }
            }
          }
        },
        responses: { "200": { description: "Secret created (returns id, never the value)" } }
      }
    },
    "/api/secrets/{id}": {
      delete: {
        tags: ["Secrets"],
        summary: "Delete a secret",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Secret deleted" }, "404": { description: "Not found" } }
      }
    },
    "/api/secrets/{id}/shares": {
      get: {
        tags: ["RBAC"],
        summary: "List cross-project shares for a secret",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Share list" } }
      },
      post: {
        tags: ["RBAC"],
        summary: "Share a secret with another project",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["projectId"], properties: { projectId: { type: "string" } } } } } },
        responses: { "200": { description: "Secret shared" } }
      }
    },
    "/api/secrets/{id}/shares/{projectId}": {
      delete: {
        tags: ["RBAC"],
        summary: "Remove a secret share",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "projectId", in: "path", required: true, schema: { type: "string" } }
        ],
        responses: { "200": { description: "Share removed" } }
      }
    },

    // ── Variables ───────────────────────────────────────────────────────────
    "/api/variables": {
      get: {
        tags: ["Variables"],
        summary: "List project-scoped variables",
        parameters: [{ name: "projectId", in: "query", schema: { type: "string" } }],
        responses: { "200": { description: "Variable list" } }
      },
      post: {
        tags: ["Variables"],
        summary: "Create a variable",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["projectId", "key", "value"], properties: { projectId: { type: "string" }, key: { type: "string" }, value: { type: "string" } } } } } },
        responses: { "200": { description: "Variable created" } }
      }
    },
    "/api/variables/{id}": {
      put: {
        tags: ["Variables"],
        summary: "Update a variable",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Variable updated" } }
      },
      delete: {
        tags: ["Variables"],
        summary: "Delete a variable",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Variable deleted" } }
      }
    },

    // ── Providers ──────────────────────────────────────────────────────────
    "/api/providers/test": {
      post: {
        tags: ["Providers"],
        summary: "Test an LLM provider connection",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["provider"],
                properties: {
                  provider: {
                    type: "object",
                    required: ["providerId", "model"],
                    properties: {
                      providerId: { type: "string" },
                      model: { type: "string" },
                      baseUrl: { type: "string" },
                      secretRef: { type: "object", properties: { secretId: { type: "string" } } },
                      temperature: { type: "number" },
                      maxTokens: { type: "integer" }
                    }
                  },
                  prompt: { type: "string" },
                  systemPrompt: { type: "string" }
                }
              }
            }
          }
        },
        responses: { "200": { description: "Connection test result" } }
      }
    },
    "/api/providers/models": {
      post: {
        tags: ["Providers"],
        summary: "List available models for a provider",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["providerId"],
                properties: {
                  providerId: { type: "string", enum: ["openai", "anthropic", "gemini", "ollama", "openai_compatible", "azure_openai"] },
                  secretRef: { type: "object", properties: { secretId: { type: "string" } } },
                  baseUrl: { type: "string" },
                  extra: { type: "object" }
                }
              }
            }
          }
        },
        responses: { "200": { description: "Model list", content: { "application/json": { schema: { type: "object", properties: { models: { type: "array", items: { type: "object", properties: { id: { type: "string" }, label: { type: "string" } } } } } } } } } }
      }
    },

    // ── MCP ─────────────────────────────────────────────────────────────────
    "/api/mcp/discover-tools": {
      post: {
        tags: ["MCP"],
        summary: "Discover tools from an MCP server",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["serverId"],
                properties: {
                  serverId: { type: "string" },
                  label: { type: "string" },
                  connection: { type: "object" },
                  secretRef: { type: "object", properties: { secretId: { type: "string" } } },
                  allowedTools: { type: "array", items: { type: "string" } },
                  projectId: { type: "string", description: "Project whose tool policy marks the tools (default: default)" }
                }
              }
            }
          }
        },
        responses: {
          "200": {
            description:
              "Discovered tools. Each carries `classification` (read-only or write, and its source) and `access` (whether the caller's role may use it in the project, and the blocking rule). Blocked tools are marked, not hidden."
          }
        }
      }
    },
    "/api/mcp/test-tool": {
      post: {
        tags: ["MCP"],
        summary: "Invoke a single MCP tool with sample arguments (dry-run from the editor)",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["serverId", "toolName"],
                properties: {
                  serverId: { type: "string" },
                  label: { type: "string" },
                  connection: { type: "object" },
                  secretRef: { type: "object", properties: { secretId: { type: "string" } } },
                  toolName: { type: "string" },
                  args: { type: "object" }
                }
              }
            }
          }
        },
        responses: { "200": { description: "Tool invocation result" } }
      }
    },
    "/api/mcp/presets": {
      get: {
        tags: ["MCP"],
        summary:
          "List MCP server presets: approved entries of the deployment catalog (MCP_CATALOG_FILE) and, in merge mode, the built-in presets",
        responses: { "200": { description: "Presets (each with origin builtin | catalog) and the catalog status" } }
      }
    },
    "/api/mcp/catalog": {
      get: {
        tags: ["MCP"],
        summary: "Deployment catalog status (file, mode, enforcement, validation errors) and its entries (builder)",
        responses: { "200": { description: "Catalog status and entries" } }
      }
    },
    "/api/mcp/catalog/reload": {
      post: {
        tags: ["MCP"],
        summary: "Re-read and validate the catalog file now (admin). A broken file keeps the last good catalog.",
        responses: { "200": { description: "New catalog status" }, "409": { description: "No catalog file configured" } }
      }
    },
    "/api/mcp/servers/import": {
      post: {
        tags: ["MCP"],
        summary:
          "Import MCP client config files into the registry (admin; builders may dryRun). Credentials become SecretService secrets; responses never contain their values.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["content"],
                properties: {
                  content: {
                    description: "The config file as text (comments and trailing commas allowed) or as a parsed object",
                    oneOf: [{ type: "string" }, { type: "object" }]
                  },
                  fileName: { type: "string" },
                  dryRun: { type: "boolean", description: "Preview only; nothing is saved" },
                  projectId: { type: "string", nullable: true },
                  probe: { type: "boolean", description: "Probe imported servers in the background (default true)" },
                  entries: {
                    type: "object",
                    description: "Per entry key: decision (create | update | copy | skip), name, and values for slots by slot id",
                    additionalProperties: {
                      type: "object",
                      properties: {
                        decision: { type: "string", enum: ["create", "update", "copy", "skip"] },
                        name: { type: "string" },
                        values: { type: "object", additionalProperties: { type: "string" } }
                      }
                    }
                  }
                }
              }
            }
          }
        },
        responses: {
          "200": { description: "Per-entry preview or results with a mapped / approximated / skipped report" },
          "400": { description: "Unreadable file or invalid payload" },
          "403": { description: "Not allowed (import needs admin)" }
        }
      }
    },
    "/api/mcp/servers/{id}/playground/call": {
      post: {
        tags: ["MCP"],
        summary:
          "Call one tool of a registered server for the signed-in user (builder). Tool policy is enforced for the caller's role and project; write tools need confirmWrite.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["toolName"],
                properties: {
                  toolName: { type: "string" },
                  args: { type: "object" },
                  projectId: { type: "string" },
                  confirmWrite: { type: "boolean" }
                }
              }
            }
          }
        },
        responses: {
          "200": { description: "Result content, structured content, duration and the JSON-RPC exchange (credentials masked)" },
          "403": { description: "Blocked by tool policy" },
          "404": { description: "Server or tool not found" },
          "409": { description: "Write tool needs confirmation, no snapshot yet, or runs are blocked by a breaking change" }
        }
      }
    },
    "/api/mcp/servers": {
      get: {
        tags: ["MCP"],
        summary: "List registered MCP servers with status and probe latency (builder)",
        parameters: [{ name: "projectId", in: "query", schema: { type: "string" } }],
        responses: { "200": { description: "Registered servers, available adapters and the default probe interval" } }
      },
      post: {
        tags: ["MCP"],
        summary: "Register an MCP server (admin). Probes it once in the background unless probing is off.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name", "adapterId"],
                properties: {
                  name: { type: "string" },
                  description: { type: "string", nullable: true },
                  adapterId: { type: "string", description: "http_mcp, stdio_mcp, mock-mcp or a community adapter" },
                  connection: { type: "object" },
                  secretRef: { type: "object", nullable: true, properties: { secretId: { type: "string" } } },
                  owner: { type: "string", nullable: true },
                  projectId: { type: "string", nullable: true },
                  probeEnabled: { type: "boolean" },
                  probeIntervalMs: { type: "integer", minimum: 10000, nullable: true },
                  blockOnBreakingChange: { type: "boolean" }
                }
              }
            }
          }
        },
        responses: { "201": { description: "Server registered" }, "400": { description: "Invalid payload, adapter or secret" } }
      }
    },
    "/api/mcp/servers/{id}": {
      get: {
        tags: ["MCP"],
        summary: "Server detail: recent probes, tool snapshots (without tool bodies) and the nodes that use it",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Server detail" }, "404": { description: "Not found" } }
      },
      put: {
        tags: ["MCP"],
        summary: "Update a registered server (admin); any field from the create payload",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Updated server" }, "404": { description: "Not found" } }
      },
      delete: {
        tags: ["MCP"],
        summary: "Delete a registered server (admin). Refused with 409 while nodes use it unless force=true.",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "force", in: "query", schema: { type: "string", enum: ["true"] } }
        ],
        responses: { "200": { description: "Deleted" }, "409": { description: "Still in use; lists the nodes" } }
      }
    },
    "/api/mcp/servers/{id}/tools": {
      get: {
        tags: ["MCP"],
        summary: "Tools from the server's current schema snapshot, with read-only classification and the caller's policy access",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "projectId", in: "query", schema: { type: "string" }, description: "Project to evaluate the policy in; defaults to the server's project, else default" }
        ],
        responses: { "200": { description: "Tool list; each tool has classification, manualReadOnly and access" } }
      }
    },
    "/api/mcp/servers/{id}/telemetry": {
      get: {
        tags: ["MCP"],
        summary: "Per-tool call telemetry for a registered server: calls, errors, p50/p95 latency, tokens and cost",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "window", in: "query", required: false, schema: { type: "string", enum: ["24h", "7d", "30d"], default: "7d" } }
        ],
        responses: {
          "200": { description: "Server totals and one row per tool, busiest first" },
          "400": { description: "Unknown window" },
          "404": { description: "MCP server not found" }
        }
      }
    },
    "/api/mcp/telemetry": {
      get: {
        tags: ["MCP"],
        summary: "Per-tool call telemetry for MCP servers configured inline on nodes, grouped by adapter and tool",
        parameters: [
          { name: "window", in: "query", required: false, schema: { type: "string", enum: ["24h", "7d", "30d"], default: "7d" } }
        ],
        responses: {
          "200": { description: "Totals and one row per adapter and tool, busiest first" },
          "400": { description: "Unknown window" }
        }
      }
    },
    "/api/mcp/tools": {
      get: {
        tags: ["MCP"],
        summary:
          "Tool catalogue across every registered server: annotations, classification, the caller's access, telemetry and the workflow nodes that use each tool (builders)",
        parameters: [
          { name: "projectId", in: "query", required: false, schema: { type: "string" } },
          { name: "window", in: "query", required: false, schema: { type: "string", enum: ["24h", "7d", "30d"], default: "7d" } },
          { name: "serverIds", in: "query", required: false, description: "Comma-separated registry server ids", schema: { type: "string" } },
          { name: "detail", in: "query", required: false, description: "false skips telemetry and usages", schema: { type: "boolean", default: true } }
        ],
        responses: {
          "200": { description: "Servers and one row per tool" },
          "400": { description: "Unknown window" }
        }
      }
    },
    "/api/mcp/changes": {
      get: {
        tags: ["MCP"],
        summary:
          "Chronological MCP changes feed: schema snapshots, breaking-change acceptances, status transitions, policy, classification, toolset, client, OAuth and sampling events (builders; actors and audit metadata for admins only)",
        parameters: [
          { name: "serverId", in: "query", required: false, schema: { type: "string" } },
          {
            name: "kind",
            in: "query",
            required: false,
            description: "Comma-separated kinds: schema, acceptance, status, policy, classification, toolset, client, oauth, sampling, catalog, server",
            schema: { type: "string" }
          },
          { name: "limit", in: "query", required: false, schema: { type: "integer", default: 100, maximum: 500 } }
        ],
        responses: {
          "200": { description: "Newest first" },
          "400": { description: "Unknown kind" }
        }
      }
    },
    "/api/mcp/overview": {
      get: {
        tags: ["MCP"],
        summary:
          "MCP fleet health: servers by status, pending breaking changes, OAuth connections needing attention, open elicitation questions, sampling, busiest and most error-prone tools, active gateway clients and the latest changes (builders)",
        parameters: [
          { name: "window", in: "query", required: false, schema: { type: "string", enum: ["24h", "7d", "30d"], default: "7d" } }
        ],
        responses: {
          "200": { description: "Overview" },
          "400": { description: "Unknown window" }
        }
      }
    },
    "/api/mcp/servers/{id}/probe": {
      post: {
        tags: ["MCP"],
        summary: "Probe the server now (initialize + tools/list) and record the result",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Probe outcome, updated server and any new snapshot" } }
      }
    },
    "/api/mcp/servers/{id}/oauth": {
      get: {
        tags: ["MCP"],
        summary: "OAuth connection status for a registry server (builder). Never includes tokens.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "{ status: state, subject, scope, authorizationServer, clientRegistration, clientId, expiresAt, hasRefreshToken, lastRefreshAt, connectedAt, connectedBy, lastError, redirectUri }, usesOAuth" },
          "404": { description: "MCP server not found" }
        }
      },
      delete: {
        tags: ["MCP"],
        summary: "Disconnect (admin): delete the stored tokens and client registration",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "{ status }" }, "403": { description: "Not an admin" }, "404": { description: "MCP server not found" } }
      }
    },
    "/api/mcp/servers/{id}/oauth/connect": {
      post: {
        tags: ["MCP"],
        summary:
          "Start the OAuth 2.1 authorization code flow (admin): discovery (RFC 9728, RFC 8414 / OIDC), dynamic client registration (RFC 7591) when no client id is configured, PKCE S256 and the RFC 8707 resource parameter. Needs a browser session.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: false,
          content: { "application/json": { schema: { type: "object", properties: { scope: { type: "string", maxLength: 1000 } } } } }
        },
        responses: {
          "200": { description: "{ authorizationUrl, expiresAt, redirectUri } — open authorizationUrl in a popup" },
          "400": { description: "Server does not use OAuth, or no browser session" },
          "403": { description: "Not an admin" },
          "502": { description: "Discovery or client registration failed" }
        }
      }
    },
    "/api/mcp/servers/{id}/oauth/refresh": {
      post: {
        tags: ["MCP"],
        summary: "Refresh the access token now (admin)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "{ status }" }, "403": { description: "Not an admin" }, "409": { description: "Refresh failed or not connected" } }
      }
    },
    "/api/mcp/servers/{id}/runtime": {
      get: {
        tags: ["MCP"],
        summary:
          "Phase 10.7 — circuit breaker and limit state of a registry server on this API instance (in memory, per instance), its limits and the last sandbox check. The breaker's last error is shown to admins only.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "{ runtime, limits, sandboxStatus }" }, "404": { description: "Unknown server" } }
      }
    },
    "/api/mcp/servers/{id}/breaker/reset": {
      post: {
        tags: ["MCP"],
        summary: "Phase 10.7 — close a server's circuit breaker by hand (admin). Audited as mcp_server.breaker_reset.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "{ runtime }" }, "403": { description: "Not an admin" }, "404": { description: "Unknown server" } }
      }
    },
    "/api/mcp/servers/{id}/connections": {
      get: {
        tags: ["MCP"],
        summary: "Phase 10.7 — who has connected their own account to a delegated server (admin). Never returns a token.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "{ credentialMode, delegatedFallback, connections: McpUserConnectionView[] }" }, "403": { description: "Not an admin" } }
      }
    },
    "/api/mcp/servers/{id}/connections/{userId}": {
      delete: {
        tags: ["MCP"],
        summary: "Phase 10.7 — revoke one user's connection to a delegated server (admin). Deletes their tokens; audited as mcp_server.user_oauth_revoked.",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "userId", in: "path", required: true, schema: { type: "string" } }
        ],
        responses: { "200": { description: "{ ok: true }" }, "403": { description: "Not an admin" }, "404": { description: "No such connection" } }
      }
    },
    "/api/mcp/connections": {
      get: {
        tags: ["MCP"],
        summary:
          "Phase 10.7 — My connections: the delegated servers the signed-in user may use (operator and up, with run rights in the server's project) and the state of their own connection to each.",
        responses: { "200": { description: "{ connections: McpMyConnection[] }" } }
      }
    },
    "/api/mcp/connections/{serverId}/connect": {
      post: {
        tags: ["MCP"],
        summary:
          "Phase 10.7 — start connecting the signed-in user's own account to a delegated server (OAuth 2.1 with PKCE; needs a browser session). The callback completes only for the same user.",
        parameters: [{ name: "serverId", in: "path", required: true, schema: { type: "string" } }],
        requestBody: { required: false, content: { "application/json": { schema: { type: "object", properties: { scope: { type: "string" } } } } } },
        responses: { "200": { description: "{ authorizationUrl, expiresAt, redirectUri }" }, "404": { description: "Not a delegated server you can use" } }
      }
    },
    "/api/mcp/connections/{serverId}": {
      delete: {
        tags: ["MCP"],
        summary: "Phase 10.7 — disconnect the signed-in user's own account from a delegated server (deletes their tokens).",
        parameters: [{ name: "serverId", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "{ connection: McpMyConnection }" } }
      }
    },
    "/api/mcp/oauth/callback": {
      get: {
        tags: ["MCP"],
        summary:
          "Redirect target for the authorization server. Validates the single-use, session-bound state, exchanges the code and renders a page that posts { type: 'l2m:mcp-oauth', serverId, ok, error } to the opener.",
        parameters: [
          { name: "code", in: "query", required: false, schema: { type: "string" } },
          { name: "state", in: "query", required: true, schema: { type: "string" } },
          { name: "error", in: "query", required: false, schema: { type: "string" } }
        ],
        responses: { "200": { description: "HTML: connected" }, "400": { description: "HTML: refused (unknown, used or expired state, other session, token error)" } }
      }
    },
    "/api/mcp/servers/{id}/snapshots/{snapshotId}": {
      get: {
        tags: ["MCP"],
        summary: "One tool schema snapshot with its tools and the diff against the previous snapshot",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "snapshotId", in: "path", required: true, schema: { type: "string" } }
        ],
        responses: { "200": { description: "Snapshot" }, "404": { description: "Not found" } }
      }
    },
    "/api/mcp/servers/{id}/accept-change": {
      post: {
        tags: ["MCP"],
        summary: "Accept the pending breaking tool schema change (admin); unblocks runs",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Accepted" }, "409": { description: "No pending breaking change" } }
      }
    },
    "/api/mcp/servers/{id}/snapshot/export": {
      get: {
        tags: ["MCP"],
        summary: "The server's accepted schema snapshot as an l2m.mcp-snapshot file, with its resources and prompts (builders)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "Snapshot file" },
          "404": { description: "Server not found" },
          "409": { description: "No accepted snapshot yet" }
        }
      }
    },
    "/api/guard/profiles": {
      get: {
        tags: ["Guard"],
        summary: "Guard profiles with their latest version and hash (viewers)",
        responses: { "200": { description: "{ profiles, autoApply, builtInId }" } }
      },
      post: {
        tags: ["Guard"],
        summary: "Create a profile from a guard profile document; version 1 (builders)",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["document"], properties: { id: { type: "string" }, document: { type: "object" }, note: { type: "string" } } } } } },
        responses: { "201": { description: "{ profile }" }, "400": { description: "{ error, issues: [{ path, message }] }" }, "409": { description: "Id already in use" } }
      }
    },
    "/api/guard/profiles/import": {
      post: {
        tags: ["Guard"],
        summary: "Import an exported profile document: creates it, or adds a version when the id exists (builders)",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { document: { type: "object" }, text: { type: "string" }, note: { type: "string" } } } } } },
        responses: { "200": { description: "{ profile, created: false, changed }" }, "201": { description: "{ profile, created: true }" }, "400": { description: "{ error, issues }" } }
      }
    },
    "/api/guard/profiles/{id}": {
      get: {
        tags: ["Guard"],
        summary: "A profile, its latest version and the bindings that use it (viewers)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "{ profile, latest, bindings }" }, "404": { description: "Not found" } }
      },
      put: {
        tags: ["Guard"],
        summary: "Save an edit as a new immutable version; an unchanged document adds none (builders; built-in is read-only)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["document"], properties: { document: { type: "object" }, note: { type: "string" } } } } } },
        responses: { "200": { description: "{ version, changed }" }, "400": { description: "{ error, issues }" }, "409": { description: "Built-in profile" } }
      },
      delete: {
        tags: ["Guard"],
        summary: "Delete a profile and its versions; refused while bound (builders; built-in cannot be deleted)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Deleted" }, "409": { description: "Built-in or still bound" } }
      }
    },
    "/api/guard/profiles/{id}/versions": {
      get: {
        tags: ["Guard"],
        summary: "Every version of a profile, newest first (viewers)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "{ versions }" } }
      }
    },
    "/api/guard/profiles/{id}/versions/{version}": {
      get: {
        tags: ["Guard"],
        summary: "One version's document, hash, author and note (viewers)",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "version", in: "path", required: true, schema: { type: "integer" } }
        ],
        responses: { "200": { description: "{ version }" }, "404": { description: "Not found" } }
      }
    },
    "/api/guard/profiles/{id}/diff": {
      get: {
        tags: ["Guard"],
        summary: "Changes between two versions as { path, kind, before, after } entries (viewers)",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "from", in: "query", required: true, schema: { type: "integer" } },
          { name: "to", in: "query", required: true, schema: { type: "integer" } }
        ],
        responses: { "200": { description: "{ from, to, changes }" }, "404": { description: "Not found" } }
      }
    },
    "/api/guard/profiles/{id}/export": {
      get: {
        tags: ["Guard"],
        summary: "Stable JSON of a version (latest by default) for policy-as-code (viewers)",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "version", in: "query", required: false, schema: { type: "integer" } }
        ],
        responses: { "200": { description: "Profile document; x-guard-profile-version and x-guard-profile-hash headers" } }
      }
    },
    "/api/guard/detectors": {
      get: { tags: ["Guard"], summary: "Detector catalogue with the channels each one checks (viewers)", responses: { "200": { description: "{ channels, detectors }" } } }
    },
    "/api/guard/bindings/projects/{projectId}": {
      get: {
        tags: ["Guard"],
        summary: "A project's binding and the profiles that apply (viewers)",
        parameters: [{ name: "projectId", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "{ binding, effective }" } }
      },
      put: {
        tags: ["Guard"],
        summary: "Set inherit, override or enforced; enforced, and any change to an enforced binding, is admin-only",
        parameters: [{ name: "projectId", in: "path", required: true, schema: { type: "string" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["mode"], properties: { mode: { type: "string", enum: ["inherit", "override", "enforced"] }, profileId: { type: "string" } } } } } },
        responses: { "200": { description: "{ binding, effective }" }, "400": { description: "{ error, issues }" }, "403": { description: "Enforced binding needs an admin" } }
      }
    },
    "/api/guard/bindings/workflows/{workflowId}": {
      get: {
        tags: ["Guard"],
        summary: "A workflow's binding, its project's binding and the effective profiles (viewers with workflow read)",
        parameters: [{ name: "workflowId", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "{ binding, project, effective }" } }
      },
      put: {
        tags: ["Guard"],
        summary: "Set inherit or override; an enforced project profile still runs first (builders with workflow write)",
        parameters: [{ name: "workflowId", in: "path", required: true, schema: { type: "string" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["mode"], properties: { mode: { type: "string", enum: ["inherit", "override"] }, profileId: { type: "string" } } } } } },
        responses: { "200": { description: "{ binding, project, effective }" }, "400": { description: "{ error, issues }" } }
      }
    },
    "/api/guard/effective": {
      get: {
        tags: ["Guard"],
        summary: "Profiles applied to agent traffic, in evaluation order, with the binding chain (viewers)",
        parameters: [
          { name: "workflowId", in: "query", required: false, schema: { type: "string" } },
          { name: "projectId", in: "query", required: false, schema: { type: "string" } }
        ],
        responses: { "200": { description: "{ effective, project, binding? }" } }
      }
    },
    "/api/executions/{id}/manifest": {
      get: {
        tags: ["Audit bundles"],
        summary: "Signed run manifest of a finished run, generated once and cached (viewers who can read the workflow)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "{ executionId, manifest, digest, keyId, algorithm, signedAt, signature }" },
          "403": { description: "No read access to the run's workflow" },
          "404": { description: "Execution not found" },
          "409": { description: "The run is still in progress" }
        }
      }
    },
    "/api/executions/{id}/bundle": {
      get: {
        tags: ["Audit bundles"],
        summary: "Audit bundle (zip): manifest, signed file index, node I/O, trace, logs, rendered outputs; audit-logged",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": { description: "application/zip; headers x-l2m-manifest-digest and x-l2m-signing-key-id" },
          "403": { description: "No read access to the run's workflow" },
          "404": { description: "Execution not found" },
          "409": { description: "The run is still in progress" },
          "413": { description: "Bundle larger than AUDIT_BUNDLE_MAX_BYTES" }
        }
      }
    },
    "/api/audit/signing-keys": {
      get: {
        tags: ["Audit bundles"],
        summary: "Signing keys (public keys only), active and retired (admins)",
        responses: { "200": { description: "{ activeKeyId, canRotate, keys }" } }
      }
    },
    "/api/audit/signing-keys/rotate": {
      post: {
        tags: ["Audit bundles"],
        summary: "Generate a new signing key and retire the current one (admins; refused when AUDIT_SIGNING_KEY_BASE64 is set)",
        responses: { "201": { description: "{ key, keys }" }, "409": { description: "The key comes from AUDIT_SIGNING_KEY_BASE64" } }
      }
    },
    "/api/executions/{id}/guard-events": {
      get: {
        tags: ["Guard"],
        summary: "Guard events of one run, in order; masked evidence only (viewers)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "{ events }" }, "404": { description: "Execution not found" } }
      }
    },
    "/api/guard/events": {
      get: {
        tags: ["Guard"],
        summary: "Latest guard events across runs, newest first (viewers)",
        parameters: [
          { name: "projectId", in: "query", required: false, schema: { type: "string" } },
          { name: "workflowId", in: "query", required: false, schema: { type: "string" } },
          { name: "profileId", in: "query", required: false, schema: { type: "string" } },
          { name: "channel", in: "query", required: false, schema: { type: "string" } },
          { name: "action", in: "query", required: false, schema: { type: "string" } },
          { name: "findings", in: "query", required: false, schema: { type: "boolean" } },
          { name: "days", in: "query", required: false, schema: { type: "integer" } },
          { name: "limit", in: "query", required: false, schema: { type: "integer", default: 50, maximum: 500 } },
          { name: "offset", in: "query", required: false, schema: { type: "integer", default: 0 } }
        ],
        responses: { "200": { description: "{ events, total }" } }
      }
    },
    "/api/guard/stats": {
      get: {
        tags: ["Guard"],
        summary: "Counts by verdict, action, category, channel and day, top detectors and shadow-mode would-have-blocked counts (viewers)",
        parameters: [
          { name: "projectId", in: "query", required: false, schema: { type: "string" } },
          { name: "workflowId", in: "query", required: false, schema: { type: "string" } },
          { name: "profileId", in: "query", required: false, schema: { type: "string" } },
          { name: "days", in: "query", required: false, schema: { type: "integer", default: 14 } }
        ],
        responses: { "200": { description: "{ since, stats }" } }
      }
    },
    "/api/mcp/cassettes": {
      get: {
        tags: ["MCP"],
        summary: "Cassettes recorded from runs and eval runs, newest first (builders)",
        parameters: [
          { name: "workflowId", in: "query", required: false, schema: { type: "string" } },
          { name: "projectId", in: "query", required: false, schema: { type: "string" } },
          { name: "evalRunId", in: "query", required: false, schema: { type: "string" } },
          { name: "limit", in: "query", required: false, schema: { type: "integer", default: 50, maximum: 500 } },
          { name: "offset", in: "query", required: false, schema: { type: "integer", default: 0 } }
        ],
        responses: { "200": { description: "{ items, total }" } }
      }
    },
    "/api/mcp/cassettes/{id}": {
      get: {
        tags: ["MCP"],
        summary: "One cassette with every recorded call, scrubbed of secrets (builders)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "{ cassette }" }, "404": { description: "Not found" } }
      },
      delete: {
        tags: ["MCP"],
        summary: "Delete a cassette (admin)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Deleted" }, "404": { description: "Not found" } }
      }
    },
    "/api/mcp/cassettes/{id}/export": {
      get: {
        tags: ["MCP"],
        summary: "The cassette as an l2m.mcp-cassette file, for l2m mcp mock --cassette (builders)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Cassette file" }, "404": { description: "Not found" } }
      }
    },
    "/api/mcp/check": {
      post: {
        tags: ["MCP"],
        summary:
          "CI check behind l2m mcp check: probe servers without recording, diff against the accepted snapshot, list policy-blocked tools workflows depend on (builders, API keys)",
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  serverIds: { type: "array", items: { type: "string" } },
                  toolsetId: { type: "string" },
                  workflowIds: { type: "array", items: { type: "string" } },
                  failOnUnreachable: { type: "boolean", default: true },
                  failOnPolicyBlocked: { type: "boolean", default: true }
                }
              }
            }
          }
        },
        responses: {
          "200": { description: "Check report; ok is false when any failure applies" },
          "404": { description: "Unknown server or toolset" }
        }
      }
    },
    "/api/executions/{id}/replay": {
      post: {
        tags: ["Executions"],
        summary: "Run a past execution again with its MCP calls answered from its cassette (builders)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  mode: { type: "string", enum: ["strict", "lenient"], default: "strict" },
                  cassetteId: { type: "string" }
                }
              }
            }
          }
        },
        responses: {
          "200": { description: "Run result with mcpReplay; a strict replay that diverged has status error" },
          "404": { description: "Execution or cassette not found" }
        }
      }
    },
    "/api/replay/recordings": {
      get: {
        tags: ["Executions"],
        summary: "Golden runs of the workflows you can read, newest first (viewers)",
        parameters: [
          { name: "workflowId", in: "query", required: false, schema: { type: "string" } },
          { name: "limit", in: "query", required: false, schema: { type: "integer", default: 50, maximum: 500 } },
          { name: "offset", in: "query", required: false, schema: { type: "integer", default: 0 } }
        ],
        responses: { "200": { description: "{ items, total }" }, "403": { description: "No access to the workflow" } }
      },
      post: {
        tags: ["Executions"],
        summary: "Save a finished execution as a golden run: its input, node results, run facts and MCP cassette are copied and scrubbed of secrets (builders)",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["executionId", "name"],
                properties: { executionId: { type: "string" }, name: { type: "string", maxLength: 200 }, notes: { type: "string", maxLength: 2000 } }
              }
            }
          }
        },
        responses: {
          "201": { description: "{ recording }" },
          "403": { description: "No write access to the workflow" },
          "404": { description: "Execution not found" },
          "409": { description: "The run has not finished, is itself a replay, is already saved as a golden run, or the workflow's golden runs (or all golden runs in the deployment) are over the count or byte limit" },
          "413": { description: "The run is larger than REPLAY_RECORDING_MAX_BYTES" }
        }
      }
    },
    "/api/replay/recordings/{id}": {
      get: {
        tags: ["Executions"],
        summary: "One golden run: input, recorded node results and run facts (viewers)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "{ recording }" }, "404": { description: "Not found" } }
      },
      delete: {
        tags: ["Executions"],
        summary: "Delete a golden run (builders)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Deleted" }, "404": { description: "Not found" } }
      }
    },
    "/api/workflows/{id}/replay-capture": {
      get: {
        tags: ["Evals"],
        summary: "Production capture settings of a workflow, the deployment's limits, candidates waiting, today's count and the last run capture dropped (`lastDrop`: outcome and time) (viewers)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "{ settings }" }, "404": { description: "Not found or not readable" } }
      },
      put: {
        tags: ["Evals"],
        summary: "Change production capture settings (builders; turning masking off is admin-only with a reason)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                additionalProperties: false,
                properties: {
                  enabled: { type: "boolean" },
                  rate: { type: "number", exclusiveMinimum: 0, maximum: 1 },
                  maxPerDay: { type: "integer", minimum: 1, maximum: 1000 },
                  onlyStatuses: { type: "array", minItems: 1, items: { type: "string", enum: ["success", "error", "canceled"] } },
                  dlp: { type: "boolean" },
                  targetDatasetId: { type: "string", nullable: true },
                  reason: { type: "string", maxLength: 500 }
                }
              }
            }
          }
        },
        responses: {
          "200": { description: "{ settings }" },
          "400": { description: "Invalid settings, a rate over REPLAY_CAPTURE_MAX_RATE, a target set of another workflow, or masking off without a reason" },
          "403": { description: "Readable but not editable, or masking off by a non-admin" },
          "404": { description: "Not found or not readable" }
        }
      }
    },
    "/api/workflows/{id}/replay-captures": {
      get: {
        tags: ["Evals"],
        summary: "The Captured runs inbox: candidate recordings of a workflow, newest first (viewers)",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "runStatus", in: "query", required: false, schema: { type: "string", enum: ["success", "error", "canceled"] } },
          {
            name: "trigger",
            in: "query",
            required: false,
            description: "A production trigger (webhook, cron, chat, ...), or api_key for runs an API key started on the execute routes (their trigger stays manual)",
            schema: { type: "string" }
          },
          { name: "from", in: "query", required: false, schema: { type: "string", format: "date-time" } },
          { name: "to", in: "query", required: false, schema: { type: "string", format: "date-time" } },
          { name: "limit", in: "query", required: false, schema: { type: "integer", minimum: 1, maximum: 200 } },
          { name: "offset", in: "query", required: false, schema: { type: "integer", minimum: 0 } }
        ],
        responses: {
          "200": { description: "{ items: [summary + { dataClasses, masked, source: api_key | null }], total }" },
          "404": { description: "Not found or not readable" }
        }
      }
    },
    "/api/replay/captures/{id}/promote": {
      post: {
        tags: ["Evals"],
        summary: "Promote a captured run into a golden set: re-scrubbed, size and count limits checked (builders)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: { required: false, content: { "application/json": { schema: { type: "object", additionalProperties: false, properties: { datasetId: { type: "string" }, name: { type: "string", maxLength: 120 } } } } } },
        responses: { "200": { description: "{ result, recording }" }, "403": { description: "Readable but not editable" }, "404": { description: "Not found, not readable or no longer in the inbox" }, "409": { description: "Over a golden-run limit" } }
      }
    },
    "/api/replay/captures/promote": {
      post: {
        tags: ["Evals"],
        summary: "Promote up to 100 captured runs; one result per id (builders)",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["ids"], properties: { ids: { type: "array", minItems: 1, maxItems: 100, items: { type: "string" } }, datasetId: { type: "string" } } } } } },
        responses: { "200": { description: "{ results, promoted }" } }
      }
    },
    "/api/replay/captures/{id}": {
      delete: {
        tags: ["Evals"],
        summary: "Discard a captured run (builders)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "{ deleted: true }" }, "403": { description: "Readable but not editable" }, "404": { description: "Not found or not readable" } }
      }
    },
    "/api/replay/captures/discard": {
      post: {
        tags: ["Evals"],
        summary: "Discard up to 100 captured runs; one result per id (builders)",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["ids"], properties: { ids: { type: "array", minItems: 1, maxItems: 100, items: { type: "string" } } } } } } },
        responses: { "200": { description: "{ results, discarded }" } }
      }
    },
    "/api/replay/recordings/find-subject": {
      post: {
        tags: ["Evals"],
        summary:
          "Data-subject lookup, preview: every golden run, captured run, golden-set case, replay result, replay execution and replay cassette holding a value, raw or as its surrogate. The value's class comes from `dataClass` when given (a value that does not parse as it is refused) or from the capture scan of the value (a `+` number with an assigned calling code is a phone); only stored values of that class match, whole values only. Each match has a certainty: `exact`, or `national_only` for a phone whose national digits agree but one side has no country code (a possible match, possibly someone else's number). `country` (ISO code or `+44`) makes a phone typed without its country code explicit; without it such a number yields possible matches only. A value not recognised as a data class is matched as exact text and needs 6 characters. Deletes nothing (admins; the value is never logged or returned)",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["value"],
                properties: {
                  value: { type: "string", minLength: 3, maxLength: 1000 },
                  dataClass: { type: "string", enum: ["email", "phone", "card_number", "us_ssn", "iban", "national_id"] },
                  country: { type: "string", pattern: "^(?:[A-Za-z]{2}|\\+\\d{1,3})$" }
                }
              }
            }
          }
        },
        responses: {
          "200": {
            description:
              "{ dataClass, callingCode, classesTried, matches: [{ kind, id, workflowId, projectId, name, status, matchedAs, fields, certainty, hits: [{ field, matchedAs, dataClass, excerpt, certainty, storedCallingCode? }] }], counts, searched, covered, notCovered }; exact matches first"
          },
          "400": { description: "Invalid value (too short for a raw search), a value that does not parse as the requested class, or an unknown country" },
          "403": { description: "Not an admin" }
        }
      }
    },
    "/api/replay/recordings/find-subject/delete": {
      post: {
        tags: ["Evals"],
        summary:
          "Data-subject lookup, delete: removes the rows named in `targets` (from a preview) after checking each still holds the value with the same strict matching (same `value`, `dataClass` and `country` as the search). A row that is only a possible match (`national_only`) is skipped unless its target says `confirmPossible: true`; a golden run takes its golden-set cases and their results with it, a run its tool-call, guard-event and usage rows. An intent audit row names every row before the first is deleted, then completion rows name every deleted id; never the value (admins)",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["value", "targets"],
                properties: {
                  value: { type: "string", minLength: 3, maxLength: 1000 },
                  dataClass: { type: "string", enum: ["email", "phone", "card_number", "us_ssn", "iban", "national_id"] },
                  country: { type: "string", pattern: "^(?:[A-Za-z]{2}|\\+\\d{1,3})$" },
                  targets: {
                    type: "array",
                    minItems: 1,
                    maxItems: 2000,
                    items: {
                      type: "object",
                      required: ["kind", "id"],
                      properties: {
                        kind: { type: "string", enum: ["recording", "fixture", "eval_result", "execution", "cassette"] },
                        id: { type: "string" },
                        confirmPossible: { type: "boolean", enum: [true], description: "Required to delete a possible match (national_only)" }
                      }
                    }
                  }
                }
              }
            }
          }
        },
        responses: {
          "200": { description: "{ deleted (per kind), removed: [{ kind, id }], skipped: [{ kind, id, reason: not_found | no_match | possible_match_unconfirmed }] }" },
          "400": { description: "Invalid request, or a row listed both with and without confirmPossible (nothing is deleted)" },
          "403": { description: "Not an admin" }
        }
      }
    },
    "/api/replay/recordings/{id}/replay": {
      post: {
        tags: ["Executions"],
        summary:
          "Replay a golden run against the draft or a saved version with every external read and write answered from the recording, then diff the result (builders)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: false,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  draft: { type: "boolean" },
                  version: { type: "integer", minimum: 1 },
                  mcpMode: { type: "string", enum: ["strict", "lenient"], default: "strict" },
                  ignorePaths: { type: "array", maxItems: 32, items: { type: "string", maxLength: 128, description: "Glob over output paths; at most eight ** segments" } },
                  numberTolerance: { type: "number", minimum: 0 }
                }
              }
            }
          }
        },
        responses: {
          "200": { description: "{ recordingId, executionId, candidate, status, diff, verdict: pass | fail | error, reasons, facts }" },
          "400": { description: "Invalid request" },
          "404": { description: "Golden run or version not found" }
        }
      }
    },
    "/api/eval/datasets": {
      get: {
        tags: ["Evals"],
        summary: "Datasets and golden sets you can read (viewers). A golden set has a workflowId.",
        parameters: [
          { name: "workflowId", in: "query", required: false, schema: { type: "string" } },
          { name: "projectId", in: "query", required: false, schema: { type: "string" } }
        ],
        responses: { "200": { description: "{ datasets: [{ id, name, workflowId, projectId, fixtureCount, goldenRunCount, ... }] }" } }
      },
      post: {
        tags: ["Evals"],
        summary: "Create a dataset; with workflowId it is a golden set in that workflow's project (builders with write access)",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", required: ["name"], properties: { name: { type: "string", maxLength: 120 }, description: { type: "string" }, workflowId: { type: "string" }, projectId: { type: "string" } } } } }
        },
        responses: { "200": { description: "{ dataset }" }, "400": { description: "Invalid request" }, "403": { description: "No write access to the workflow or project" } }
      }
    },
    "/api/eval/datasets/{id}/recordings": {
      post: {
        tags: ["Evals"],
        summary: "Add a golden run of the set's workflow as a case; its recorded output is the expected value (builders)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", required: ["recordingId"], properties: { recordingId: { type: "string" }, name: { type: "string" }, scorers: { type: "array", items: { type: "object" } } } } } }
        },
        responses: { "201": { description: "{ fixture }" }, "400": { description: "Not a golden set, or an invalid scorer" }, "404": { description: "Set or golden run not found" }, "409": { description: "Already in the set" } }
      }
    },
    "/api/eval/runs": {
      post: {
        tags: ["Evals"],
        summary: "Queue an eval run over a dataset; it runs in the background (builders with execute access). ?wait=true waits and answers 200 { ok, runId, summary } (deprecated, kept for one release).",
        parameters: [{ name: "wait", in: "query", required: false, schema: { type: "boolean" } }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", required: ["datasetId", "workflowId"], properties: { datasetId: { type: "string" }, workflowId: { type: "string" }, scorers: { type: "array", items: { type: "object" } }, record: { type: "boolean" }, replay: { type: "object" } } } } }
        },
        responses: { "202": { description: "{ run, runId }; the run stops at EVAL_RUN_MAX_COST_USD" }, "200": { description: "With ?wait=true: { ok, runId, summary }" }, "400": { description: "Invalid request or scorers, a judge secret that cannot be used (on the request or a case), an empty dataset, or a golden set of another workflow or with only golden runs; with ?wait=true every runner refusal" }, "403": { description: "Read access to the workflow but no execute access" }, "404": { description: "Dataset, workflow, cassette or source eval run not found or not readable" }, "409": { description: "More cases than REPLAY_JOB_MAX_CASES" } }
      },
      get: {
        tags: ["Evals"],
        summary: "Eval runs and replay jobs of the workflows you can read (viewers)",
        parameters: [
          { name: "workflowId", in: "query", required: false, schema: { type: "string" } },
          { name: "datasetId", in: "query", required: false, schema: { type: "string" } },
          { name: "kind", in: "query", required: false, schema: { type: "string", enum: ["eval", "replay"] } },
          { name: "limit", in: "query", required: false, schema: { type: "integer", maximum: 500 } }
        ],
        responses: { "200": { description: "{ runs }" } }
      }
    },
    "/api/eval/runs/{id}": {
      get: { tags: ["Evals"], summary: "One run with its case results (viewers)", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "run with results" }, "404": { description: "Not found or not readable" } } }
    },
    "/api/eval/runs/{id}/cancel": {
      post: { tags: ["Evals"], summary: "Cancel a queued or running run: no further cases start and running executions are aborted (builders)", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "{ run }" }, "403": { description: "Readable but no execute access" }, "404": { description: "Not found or not readable" }, "409": { description: "Already finished" } } }
    },
    "/api/eval/runs/{id}/events": {
      get: {
        tags: ["Evals"],
        summary: "Server-sent events: `progress` after every case and `done` when the run finishes, each { type, run } (viewers)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "SSE stream", content: { "text/event-stream": { schema: { type: "string" } } } }, "404": { description: "Not found or not readable; no stream is opened" } }
      }
    },
    "/api/replay/runs": {
      post: {
        tags: ["Evals"],
        summary: "Queue a replay job: every golden run in the sets is replayed against the draft or a saved version and scored (builders with execute access)",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["datasetIds"],
                properties: {
                  datasetIds: { type: "array", minItems: 1, maxItems: 10, items: { type: "string" } },
                  draft: { type: "boolean" },
                  version: { type: "integer", minimum: 1 },
                  mcpMode: { type: "string", enum: ["strict", "lenient"] },
                  ignorePaths: { type: "array", items: { type: "string" } },
                  numberTolerance: { type: "number", minimum: 0 },
                  scorers: { type: "array", maxItems: 20, items: { type: "object", description: "json_equal, json_schema, text_similarity, tool_sequence, status, no_new_guard_blocks, budget, llm_judge (secretRef), and the eval scorers" } },
                  maxCostUsd: { type: "number", exclusiveMinimum: 0 }
                }
              }
            }
          }
        },
        responses: { "202": { description: "{ run }" }, "400": { description: "Invalid request, not a golden set, no golden runs, or a judge secret that cannot be used" }, "403": { description: "Read access to the workflow but no execute access" }, "404": { description: "A set that is missing, not readable or another workflow's, or a version not found" }, "409": { description: "More cases than REPLAY_JOB_MAX_CASES" } }
      },
      get: {
        tags: ["Evals"],
        summary: "Replay jobs of the workflows you can read (viewers)",
        parameters: [
          { name: "workflowId", in: "query", required: false, schema: { type: "string" } },
          { name: "datasetId", in: "query", required: false, schema: { type: "string" } }
        ],
        responses: { "200": { description: "{ runs }" } }
      }
    },
    "/api/replay/runs/{id}": {
      get: { tags: ["Evals"], summary: "One replay job: candidate, options, progress, summary and case results without diffs (viewers)", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "{ run }" }, "404": { description: "Not found" } } }
    },
    "/api/replay/runs/{id}/results/{resultId}": {
      get: {
        tags: ["Evals"],
        summary: "One case with its scores and run diff (viewers)",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "resultId", in: "path", required: true, schema: { type: "string" } }
        ],
        responses: { "200": { description: "{ result }" }, "404": { description: "Not found" } }
      }
    },
    "/api/replay/runs/{id}/cancel": {
      post: { tags: ["Evals"], summary: "Cancel a replay job (builders)", parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "{ run }" }, "403": { description: "Readable but no execute access" }, "404": { description: "Not found or not readable" }, "409": { description: "Already finished" } } }
    },
    "/api/mcp/servers/{id}/tools/{toolName}/classification": {
      put: {
        tags: ["MCP"],
        summary: "Override a tool's read-only classification (admin). readOnly null clears the override so annotations decide again.",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "toolName", in: "path", required: true, schema: { type: "string" } }
        ],
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { type: "object", required: ["readOnly"], properties: { readOnly: { type: "boolean", nullable: true } } }
            }
          }
        },
        responses: { "200": { description: "Override and effective classification" }, "404": { description: "MCP server not found" } }
      }
    },
    "/api/mcp/policies": {
      get: {
        tags: ["MCP"],
        summary: "List MCP tool policy rules in evaluation order (builder)",
        responses: { "200": { description: "Rules and the roles a rule can target" } }
      },
      post: {
        tags: ["MCP"],
        summary: "Create a tool policy rule (admin). Deny wins; a strictly narrower allow carves an exception out of a deny.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["effect"],
                properties: {
                  name: { type: "string", nullable: true },
                  description: { type: "string", nullable: true },
                  effect: { type: "string", enum: ["allow", "deny"] },
                  projectId: { type: "string", nullable: true, description: "null = every project" },
                  roles: { type: "array", items: { type: "string", enum: ["admin", "builder", "operator", "viewer"] }, description: "empty = every role" },
                  serverId: { type: "string", nullable: true, description: "Registry server id, or an adapter id for inline servers; null = any server" },
                  toolPattern: { type: "string", default: "*", description: "Tool name, or a glob where * matches any characters" },
                  annotationHint: {
                    type: "string",
                    nullable: true,
                    enum: ["destructive", "not_destructive", "read_only", "not_read_only", "idempotent", "not_idempotent", "open_world", "not_open_world"],
                    description: "Only match tools whose effective annotation hints meet this condition (missing hints use the MCP defaults)"
                  },
                  enabled: { type: "boolean", default: true }
                }
              }
            }
          }
        },
        responses: { "201": { description: "Rule created" }, "400": { description: "Invalid rule, project or server" } }
      }
    },
    "/api/mcp/policies/{id}": {
      put: {
        tags: ["MCP"],
        summary: "Update a tool policy rule (admin); any field from the create payload",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Updated rule" }, "404": { description: "Not found" } }
      },
      delete: {
        tags: ["MCP"],
        summary: "Delete a tool policy rule (admin)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Deleted" }, "404": { description: "Not found" } }
      }
    },
    "/api/mcp/policies/evaluate": {
      post: {
        tags: ["MCP"],
        summary: "Dry-run the tool policy for a role, project, server and tool (builder)",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["role", "serverId", "toolName"],
                properties: {
                  projectId: { type: "string", nullable: true },
                  role: { type: "string", enum: ["admin", "builder", "operator", "viewer"] },
                  serverId: { type: "string", description: "Registry server id or adapter id" },
                  toolName: { type: "string" },
                  noWriteTools: { type: "boolean", description: "Also apply a workflow's No write tools setting" }
                }
              }
            }
          }
        },
        responses: {
          "200": { description: "Decision, deciding and matching rules, set-aside denies and the tool's classification" },
          "404": { description: "Unknown server or adapter" }
        }
      }
    },

    // ── Connectors ──────────────────────────────────────────────────────────
    "/api/connectors/test": {
      post: {
        tags: ["Providers"],
        summary: "Test a data connector connection",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", required: ["connectorId"], properties: { connectorId: { type: "string" }, connectorConfig: { type: "object" } } } } }
        },
        responses: { "200": { description: "Connector test result" } }
      }
    },

    // ── Code Node ───────────────────────────────────────────────────────────
    "/api/code-node/test": {
      post: {
        tags: ["Workflows"],
        summary: "Test a code node in a sandbox",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", required: ["code"], properties: { code: { type: "string" }, timeout: { type: "integer" }, input: { type: "object" } } } } }
        },
        responses: { "200": { description: "Code execution result" } }
      }
    },

    // ── Expressions ─────────────────────────────────────────────────────────
    "/api/expressions/preview": {
      post: {
        tags: ["Workflows"],
        summary: "Preview an expression or template evaluation",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", required: ["expression"], properties: { expression: { type: "string" }, mode: { type: "string", enum: ["expression", "template"] }, context: { type: "object" } } } } }
        },
        responses: { "200": { description: "Expression result" } }
      }
    },

    // ── Definitions & Integrations ──────────────────────────────────────────
    "/api/definitions": {
      get: {
        tags: ["Workflows"],
        summary: "Get all node, provider, connector, and MCP server definitions",
        responses: { "200": { description: "Registry definitions" } }
      }
    },
    "/api/integrations": {
      get: {
        tags: ["Workflows"],
        summary: "List available integrations (Tier 1 + Tier 2)",
        responses: { "200": { description: "Integration catalog" } }
      }
    },

    // ── External Secret Providers ──────────────────────────────────────────
    "/api/external-providers": {
      get: {
        tags: ["ExternalSecrets"],
        summary: "List external secret providers",
        responses: { "200": { description: "Provider list" } }
      },
      post: {
        tags: ["ExternalSecrets"],
        summary: "Create an external secret provider",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name", "type"],
                properties: {
                  name: { type: "string" },
                  type: { type: "string", enum: ["aws-secrets-manager", "hashicorp-vault", "google-secret-manager", "azure-key-vault", "mock"] },
                  config: { type: "object" },
                  credentialsSecretId: { type: "string", nullable: true },
                  cacheTtlMs: { type: "integer" }
                }
              }
            }
          }
        },
        responses: { "200": { description: "Provider created" } }
      }
    },
    "/api/external-providers/{id}": {
      put: {
        tags: ["ExternalSecrets"],
        summary: "Update an external secret provider",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Provider updated" } }
      },
      delete: {
        tags: ["ExternalSecrets"],
        summary: "Delete an external secret provider",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Provider deleted" } }
      }
    },
    "/api/external-providers/{id}/test": {
      post: {
        tags: ["ExternalSecrets"],
        summary: "Test an external secret provider by resolving a key",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["key"], properties: { key: { type: "string" } } } } } },
        responses: { "200": { description: "Test result" } }
      }
    },

    // ── Git ─────────────────────────────────────────────────────────────────
    "/api/git": {
      get: {
        tags: ["Git"],
        summary: "Get git sync configuration and status",
        responses: { "200": { description: "Git config and status" } }
      },
      put: {
        tags: ["Git"],
        summary: "Configure git sync",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", required: ["repoUrl"], properties: { repoUrl: { type: "string" }, defaultBranch: { type: "string" }, authSecretId: { type: "string", nullable: true }, workflowsDir: { type: "string" }, enabled: { type: "boolean" } } } } }
        },
        responses: { "200": { description: "Git configured" } }
      },
      delete: {
        tags: ["Git"],
        summary: "Disconnect git sync",
        responses: { "200": { description: "Git disconnected" } }
      }
    },
    "/api/git/status": {
      get: {
        tags: ["Git"],
        summary: "Get current git sync status",
        responses: { "200": { description: "Sync status" } }
      }
    },
    "/api/git/push": {
      post: {
        tags: ["Git"],
        summary: "Push workflows and variables to git remote",
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { branch: { type: "string" }, message: { type: "string" } } } } } },
        responses: { "200": { description: "Push result" } }
      }
    },
    "/api/git/pull": {
      post: {
        tags: ["Git"],
        summary: "Pull workflows and variables from git remote",
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { branch: { type: "string" }, message: { type: "string" } } } } } },
        responses: { "200": { description: "Pull result" } }
      }
    },

    // ── Audit ───────────────────────────────────────────────────────────────
    "/api/audit": {
      get: {
        tags: ["Audit"],
        summary: "Query audit log (admin only)",
        parameters: [
          { name: "category", in: "query", schema: { type: "string" } },
          { name: "eventType", in: "query", schema: { type: "string" } },
          { name: "outcome", in: "query", schema: { type: "string" } },
          { name: "actorUserId", in: "query", schema: { type: "string" } },
          { name: "resourceType", in: "query", schema: { type: "string" } },
          { name: "resourceId", in: "query", schema: { type: "string" } },
          { name: "from", in: "query", schema: { type: "string", format: "date-time" } },
          { name: "to", in: "query", schema: { type: "string", format: "date-time" } },
          { name: "page", in: "query", schema: { type: "integer" } },
          { name: "pageSize", in: "query", schema: { type: "integer" } }
        ],
        responses: { "200": { description: "Paginated audit events" } }
      }
    },
    "/api/audit/export": {
      get: {
        tags: ["Audit"],
        summary: "Export audit log as CSV",
        responses: { "200": { description: "CSV file download", content: { "text/csv": { schema: { type: "string" } } } } }
      }
    },

    // ── Log Streaming ──────────────────────────────────────────────────────
    "/api/log-streams": {
      get: {
        tags: ["LogStreaming"],
        summary: "List log streaming destinations",
        responses: { "200": { description: "Destination list" } }
      },
      post: {
        tags: ["LogStreaming"],
        summary: "Create a log streaming destination",
        requestBody: {
          required: true,
          content: { "application/json": { schema: { type: "object", required: ["name", "type", "config"], properties: { name: { type: "string" }, type: { type: "string", enum: ["syslog", "webhook", "sentry"] }, enabled: { type: "boolean" }, categories: { type: "array", items: { type: "string" } }, minLevel: { type: "string", enum: ["debug", "info", "warn", "error"] }, config: { type: "object" } } } } }
        },
        responses: { "200": { description: "Destination created" } }
      }
    },
    "/api/log-streams/{id}": {
      put: {
        tags: ["LogStreaming"],
        summary: "Update a log streaming destination",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Destination updated" } }
      },
      delete: {
        tags: ["LogStreaming"],
        summary: "Delete a log streaming destination",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Destination deleted" } }
      }
    },
    "/api/log-streams/{id}/test": {
      post: {
        tags: ["LogStreaming"],
        summary: "Test a log streaming destination",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Test result" } }
      }
    },
    "/api/log-streams/{id}/events": {
      get: {
        tags: ["LogStreaming"],
        summary: "List recent delivery events for a destination",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Event list" } }
      }
    },

    // ── Custom Roles ────────────────────────────────────────────────────────
    "/api/custom-roles": {
      get: {
        tags: ["RBAC"],
        summary: "List custom roles",
        parameters: [{ name: "projectId", in: "query", schema: { type: "string" } }],
        responses: { "200": { description: "Custom role list with available permissions" } }
      },
      post: {
        tags: ["RBAC"],
        summary: "Create a custom role (admin only)",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["name", "permissions"], properties: { name: { type: "string" }, description: { type: "string", nullable: true }, projectId: { type: "string", nullable: true }, permissions: { type: "array", items: { type: "string" } } } } } } },
        responses: { "200": { description: "Custom role created" } }
      }
    },
    "/api/custom-roles/{id}": {
      put: {
        tags: ["RBAC"],
        summary: "Update a custom role",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Custom role updated" } }
      },
      delete: {
        tags: ["RBAC"],
        summary: "Delete a custom role",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Custom role deleted" } }
      }
    },

    // ── Queue ───────────────────────────────────────────────────────────────
    "/api/queue/depth": {
      get: {
        tags: ["Queue"],
        summary: "Get current execution queue depth",
        responses: { "200": { description: "Queue depth info" } }
      }
    },
    "/api/queue/dlq": {
      get: {
        tags: ["Queue"],
        summary: "List dead-letter queue entries",
        parameters: [{ name: "limit", in: "query", schema: { type: "integer" } }],
        responses: { "200": { description: "DLQ entries" } }
      }
    },

    // ── Webhooks ────────────────────────────────────────────────────────────
    "/api/webhooks/execute": {
      post: {
        tags: ["Triggers"],
        summary: "Execute a workflow via webhook payload (authenticated)",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { workflow_id: { type: "string" }, webhook_path: { type: "string" }, system_prompt: { type: "string" }, user_prompt: { type: "string" }, session_id: { type: "string" }, variables: { type: "object" } } } } } },
        responses: { "200": { description: "Execution result" } }
      }
    },
    "/api/webhooks/slack/{workflowId}": {
      post: {
        tags: ["Triggers"],
        summary: "Slack Events API webhook endpoint",
        parameters: [{ name: "workflowId", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Event processed" } }
      }
    },
    "/api/webhooks/github/{workflowId}": {
      post: {
        tags: ["Triggers"],
        summary: "GitHub webhook endpoint (validates X-Hub-Signature-256)",
        parameters: [{ name: "workflowId", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Event processed" } }
      }
    },
    "/webhook/{path}": {
      get: { tags: ["Triggers"], summary: "Production webhook (any method)", parameters: [{ name: "path", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Workflow execution result" } } },
      post: { tags: ["Triggers"], summary: "Production webhook (any method)", parameters: [{ name: "path", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Workflow execution result" } } }
    },
    "/webhook-test/{path}": {
      get: { tags: ["Triggers"], summary: "Test webhook (any method)", parameters: [{ name: "path", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Workflow execution result" } } },
      post: { tags: ["Triggers"], summary: "Test webhook (any method)", parameters: [{ name: "path", in: "path", required: true, schema: { type: "string" } }], responses: { "200": { description: "Workflow execution result" } } }
    },

    // ── MCP Server (exposed) ────────────────────────────────────────────────
    "/api/mcp-server/{path}/manifest": {
      get: {
        tags: ["MCP"],
        summary: "Get MCP server manifest for a workflow",
        parameters: [{ name: "path", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "MCP manifest" } }
      }
    },
    "/api/mcp-server/{path}/invoke": {
      post: {
        tags: ["MCP"],
        summary: "Invoke an MCP tool on a workflow",
        parameters: [{ name: "path", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Invocation result" } }
      }
    },

    // ── MCP gateway (Phase 10.4) ────────────────────────────────────────────
    "/mcp/{toolset}": {
      post: {
        tags: ["MCP"],
        summary:
          "MCP Streamable HTTP endpoint for a toolset (JSON-RPC 2.0: initialize, ping, tools/list, tools/call, notifications/initialized, notifications/cancelled). Bearer client token scoped to the toolset.",
        description:
          "Protocol versions 2025-11-25, 2025-06-18 and 2025-03-26 (batches only in 2025-03-26). Responds with application/json, or text/event-stream when a request carries _meta.progressToken and Accept allows SSE. initialize returns the Mcp-Session-Id header that later requests must send. Origin must be absent, WEB_ORIGIN, MCP_GATEWAY_PUBLIC_URL or listed in MCP_GATEWAY_ALLOWED_ORIGINS.",
        parameters: [
          { name: "toolset", in: "path", required: true, schema: { type: "string" } },
          { name: "Mcp-Session-Id", in: "header", required: false, schema: { type: "string" } },
          { name: "MCP-Protocol-Version", in: "header", required: false, schema: { type: "string" } }
        ],
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", description: "JSON-RPC 2.0 message (or batch, 2025-03-26 only)" } } } },
        responses: {
          "200": { description: "JSON-RPC response (application/json) or SSE stream with progress notifications and the response" },
          "202": { description: "Notifications accepted" },
          "400": { description: "Parse error, missing session id, unsupported protocol version or batch" },
          "401": { description: "Missing, invalid, revoked or expired client token" },
          "403": { description: "Origin not allowed, or the token is not scoped to this toolset" },
          "404": { description: "Unknown or disabled toolset, or unknown session" },
          "503": { description: "Session limit reached and no session is idle" }
        }
      },
      get: {
        tags: ["MCP"],
        summary: "Server-initiated SSE stream: not offered (405)",
        parameters: [{ name: "toolset", in: "path", required: true, schema: { type: "string" } }],
        responses: { "405": { description: "Method not allowed" } }
      },
      delete: {
        tags: ["MCP"],
        summary: "End an MCP session (stops the stdio servers it started)",
        parameters: [
          { name: "toolset", in: "path", required: true, schema: { type: "string" } },
          { name: "Mcp-Session-Id", in: "header", required: true, schema: { type: "string" } }
        ],
        responses: { "204": { description: "Session ended" }, "404": { description: "Unknown session" } }
      }
    },
    "/api/mcp/toolsets": {
      get: {
        tags: ["MCP"],
        summary: "List MCP gateway toolsets with members, endpoint path and open sessions (builder)",
        responses: { "200": { description: "Toolsets, the configured public base URL and supported protocol versions" } }
      },
      post: {
        tags: ["MCP"],
        summary: "Create a toolset (admin)",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name"],
                properties: {
                  name: { type: "string" },
                  slug: { type: "string", description: "Lowercase letters, digits and dashes; derived from the name when omitted" },
                  description: { type: "string", nullable: true },
                  projectId: { type: "string", nullable: true, description: "Project the tool policy is evaluated in" },
                  enabled: { type: "boolean", default: true },
                  members: {
                    type: "array",
                    items: {
                      type: "object",
                      required: ["kind"],
                      properties: {
                        kind: { type: "string", enum: ["workflow", "server"] },
                        workflowId: { type: "string", description: "kind=workflow: a workflow with an Expose as MCP Tool trigger" },
                        serverId: { type: "string", description: "kind=server: a registry server id" },
                        toolGlob: { type: "string", nullable: true, description: "kind=server: tool name or glob; null = every tool" }
                      }
                    }
                  }
                }
              }
            }
          }
        },
        responses: { "201": { description: "Toolset created" }, "400": { description: "Invalid payload, member or project" }, "409": { description: "Slug taken" } }
      }
    },
    "/api/mcp/toolsets/candidates": {
      get: {
        tags: ["MCP"],
        summary: "Workflows that can join a toolset (they have an Expose as MCP Tool trigger) (builder)",
        responses: { "200": { description: "Workflows and their tool names" } }
      }
    },
    "/api/mcp/toolsets/{id}": {
      get: {
        tags: ["MCP"],
        summary: "Get a toolset (builder)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Toolset" }, "404": { description: "Not found" } }
      },
      put: {
        tags: ["MCP"],
        summary: "Update a toolset (admin); members, when sent, replace the list. A new slug or disabling ends its sessions.",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Updated toolset" }, "404": { description: "Not found" }, "409": { description: "Slug taken" } }
      },
      delete: {
        tags: ["MCP"],
        summary: "Delete a toolset (admin); removes it from every client's scope and ends its sessions",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Deleted" }, "404": { description: "Not found" } }
      }
    },
    "/api/mcp/toolsets/{id}/preview": {
      get: {
        tags: ["MCP"],
        summary: "Tools a role would see through this toolset, tools the policy hides, and member warnings (builder)",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "role", in: "query", required: false, schema: { type: "string", enum: ["admin", "builder", "operator", "viewer"] } }
        ],
        responses: { "200": { description: "Preview" }, "400": { description: "Unknown role" }, "404": { description: "Not found" } }
      }
    },
    "/api/mcp/toolsets/{id}/members": {
      post: {
        tags: ["MCP"],
        summary: "Add one member to a toolset (admin)",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "201": { description: "Updated toolset" }, "400": { description: "Invalid member" }, "404": { description: "Not found" } }
      }
    },
    "/api/mcp/toolsets/{id}/members/{memberId}": {
      delete: {
        tags: ["MCP"],
        summary: "Remove a member from a toolset (admin)",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "memberId", in: "path", required: true, schema: { type: "string" } }
        ],
        responses: { "200": { description: "Updated toolset" }, "404": { description: "Not found" } }
      }
    },
    "/api/mcp/clients": {
      get: {
        tags: ["MCP"],
        summary: "List MCP client credentials with status, effective role and 7-day usage (builder). Never returns tokens.",
        responses: { "200": { description: "Clients" } }
      },
      post: {
        tags: ["MCP"],
        summary: "Create a client credential (admin). The response is the only one that carries the token.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name", "toolsetIds", "role"],
                properties: {
                  name: { type: "string" },
                  toolsetIds: { type: "array", items: { type: "string" } },
                  role: { type: "string", enum: ["admin", "builder", "operator", "viewer"], description: "Capped at the creator's current role when used" },
                  expiresAt: { type: "string", format: "date-time", nullable: true }
                }
              }
            }
          }
        },
        responses: { "201": { description: "Client and its one-time token" }, "400": { description: "Invalid payload or toolset" }, "403": { description: "Role above the creator's" } }
      }
    },
    "/api/mcp/clients/{id}/revoke": {
      post: {
        tags: ["MCP"],
        summary: "Revoke a client credential (admin); its open sessions end",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Revoked client" }, "404": { description: "Not found" } }
      }
    },
    "/api/mcp/clients/{id}/usage": {
      get: {
        tags: ["MCP"],
        summary: "A client's gateway calls, errors, latency and last use per tool (builder)",
        parameters: [
          { name: "id", in: "path", required: true, schema: { type: "string" } },
          { name: "window", in: "query", required: false, schema: { type: "string", enum: ["24h", "7d", "30d"] } }
        ],
        responses: { "200": { description: "Usage rollup" }, "404": { description: "Not found" } }
      }
    },

    // ── OpenAPI (self) ──────────────────────────────────────────────────────
    "/api/openapi.json": {
      get: {
        tags: ["Observability"],
        summary: "OpenAPI 3.0 specification (this document)",
        responses: { "200": { description: "OpenAPI JSON spec", content: { "application/json": { schema: { type: "object" } } } } }
      }
    },
    "/api/docs": {
      get: {
        tags: ["Observability"],
        summary: "Swagger UI documentation page",
        responses: { "200": { description: "HTML page", content: { "text/html": { schema: { type: "string" } } } } }
      }
    }
  },
  components: {
    securitySchemes: {
      sessionCookie: {
        type: "apiKey" as const,
        in: "cookie" as const,
        name: "ao_session",
        description: "Session cookie set by /api/auth/login"
      },
      bearerToken: {
        type: "http" as const,
        scheme: "bearer",
        description: "API key from /api/auth/api-keys"
      }
    },
    schemas: {
      SafeUser: {
        type: "object",
        properties: {
          id: { type: "string" },
          email: { type: "string" },
          role: { type: "string", enum: ["admin", "builder", "operator", "viewer"] }
        }
      },
      Workflow: {
        type: "object",
        description: "Workflow definition (schemaVersion 1.0.0)",
        required: ["id", "name", "nodes", "edges"],
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          schemaVersion: { type: "string", example: "1.0.0" },
          nodes: { type: "array", items: { type: "object" } },
          edges: { type: "array", items: { type: "object" } },
          projectId: { type: "string" },
          folderId: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          variables: { type: "object" },
          workflowVersion: { type: "integer" }
        }
      },
      Error: {
        type: "object",
        properties: {
          error: { type: "string" }
        }
      }
    }
  },
  security: [
    { sessionCookie: [] },
    { bearerToken: [] }
  ]
} as const;
