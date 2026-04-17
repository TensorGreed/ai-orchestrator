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
        summary: "Complete MFA challenge during login",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["challenge", "code"],
                properties: {
                  challenge: { type: "string" },
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
        summary: "Initiate SAML SSO login (redirects to IdP)",
        responses: { "302": { description: "Redirect to SAML IdP" } }
      }
    },
    "/api/auth/saml/callback": {
      post: {
        tags: ["Auth"],
        summary: "SAML SSO assertion callback",
        responses: { "200": { description: "User authenticated via SAML" } }
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
          content: { "application/json": { schema: { type: "object", required: ["provider", "groupName", "role"], properties: { provider: { type: "string", enum: ["saml", "ldap"] }, groupName: { type: "string" }, role: { type: "string" }, projectId: { type: "string", nullable: true }, customRoleId: { type: "string", nullable: true } } } } }
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
                  executionTimeoutMs: { type: "integer" }
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
          "200": { description: "SSE stream of node_start, node_complete, llm_delta, result events", content: { "text/event-stream": { schema: { type: "string" } } } },
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
        summary: "List pending approval requests",
        responses: { "200": { description: "Pending approvals" } }
      }
    },
    "/api/approvals/{id}/approve": {
      post: {
        tags: ["Approvals"],
        summary: "Approve a pending execution",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "Execution resumed" }, "404": { description: "Approval not found" } }
      }
    },
    "/api/approvals/{id}/reject": {
      post: {
        tags: ["Approvals"],
        summary: "Reject a pending execution",
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        requestBody: { content: { "application/json": { schema: { type: "object", properties: { reason: { type: "string" } } } } } },
        responses: { "200": { description: "Execution rejected" }, "404": { description: "Approval not found" } }
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
                  allowedTools: { type: "array", items: { type: "string" } }
                }
              }
            }
          }
        },
        responses: { "200": { description: "Discovered tools" } }
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
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", properties: { workflow_id: { type: "string" }, system_prompt: { type: "string" }, user_prompt: { type: "string" }, session_id: { type: "string" }, variables: { type: "object" } } } } } },
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
