/**
 * Run-time project scope: which sub-workflows, error workflows, secrets and
 * session state a running workflow can reach (run-scope.ts).
 */
import { describe, expect, it } from "vitest";
import type { Workflow } from "@ai-orchestrator/shared";
import { createRunScope, projectSessionNamespace, type RunScopeDeps } from "./run-scope.js";
import type { SafeUser } from "./services/auth-service.js";

const workflow = (id: string, projectId?: string): Workflow => ({
  id,
  name: id,
  schemaVersion: "1.0.0",
  workflowVersion: 1,
  ...(projectId ? { projectId } : {}),
  nodes: [],
  edges: []
});

const user = (role: SafeUser["role"], id = `u-${role}`): SafeUser => ({ id, email: `${id}@x`, role }) as SafeUser;

function scopeFixture(overrides: Partial<RunScopeDeps> = {}) {
  const workflows: Record<string, Workflow> = {
    "a-1": workflow("a-1", "pa"),
    "a-2": workflow("a-2", "pa"),
    "b-1": workflow("b-1", "pb"),
    "b-shared": workflow("b-shared", "pb"),
    "b-read-share": workflow("b-read-share", "pb"),
    legacy: workflow("legacy")
  };
  const secrets: Record<string, string> = { "s-a": "pa", "s-b": "pb", "s-default": "default", "s-shared": "pb" };
  const memory = new Map<string, unknown[]>();
  const toolCalls: Array<{ id: string; namespace: string; sessionId: string; toolName: string; args: Record<string, unknown>; output: unknown; createdAt: string }> = [];
  const artifacts = new Map<string, { namespace: string; sessionId: string; artifactKey: string; value: unknown; createdAt: string; updatedAt: string }>();
  const resolved: string[] = [];
  const deps: RunScopeDeps = {
    getWorkflow: (id) => workflows[id] ?? null,
    listWorkflowShares: (id) =>
      id === "b-shared" ? [{ projectId: "pa", accessLevel: "execute" }] : id === "b-read-share" ? [{ projectId: "pa", accessLevel: "read" }] : [],
    // u-runner may execute anything in pb; nobody else may.
    canExecuteWorkflow: (actor, target) => actor.id === "u-runner" && target.projectId === "pb",
    getSecretProjectId: (id) => secrets[id] ?? null,
    listSecretIdsSharedToProject: (projectId) => (projectId === "pa" ? ["s-shared"] : []),
    canUseSecretsInProject: (actor) => actor.id !== "u-no-secrets",
    resolveSecret: async (ref) => {
      resolved.push(ref!.secretId);
      return `value-of-${ref!.secretId}`;
    },
    knowledgeBaseStoreFor: () => ({ addKnowledgeBaseChunks: () => 0, listKnowledgeBaseChunks: () => [], bm25SearchKnowledgeBase: () => [], getKnowledgeBase: () => null }) as never,
    sessions: {
      loadMemory: (namespace, sessionId) => (memory.get(`${namespace}|${sessionId}`) ?? []) as never,
      saveMemory: (namespace, sessionId, messages) => void memory.set(`${namespace}|${sessionId}`, messages),
      saveToolCall: (input) => {
        const row = { ...input, id: `t${toolCalls.length}`, createdAt: new Date(Date.now() + toolCalls.length).toISOString() };
        toolCalls.push(row);
        return row;
      },
      listToolCalls: (input) => toolCalls.filter((row) => row.namespace === input.namespace && row.sessionId === input.sessionId),
      getToolCall: (input) => toolCalls.find((row) => row.namespace === input.namespace && row.sessionId === input.sessionId && row.id === input.id) ?? null,
      saveArtifact: (input) => {
        const row = { ...input, createdAt: "t", updatedAt: "t" };
        artifacts.set(`${input.namespace}|${input.sessionId}|${input.artifactKey}`, row);
        return row;
      },
      loadArtifact: (input) => artifacts.get(`${input.namespace}|${input.sessionId}|${input.artifactKey}`) ?? null
    },
    ...overrides
  };
  return { scope: createRunScope(deps), workflows, memory, toolCalls, artifacts, resolved };
}

describe("run scope: sub-workflows and error workflows", () => {
  it("loads same-project, project-less and execute-shared children, and refuses the rest with a clear error", () => {
    const { scope, workflows } = scopeFixture();
    const load = scope.dependenciesFor(workflows["a-1"]!).loadWorkflow;
    expect(load("a-2")?.id).toBe("a-2");
    expect(load("legacy")?.id).toBe("legacy");
    expect(load("b-shared")?.id).toBe("b-shared");
    expect(load("missing")).toBeUndefined();
    expect(() => load("b-1")).toThrow(/Sub-workflow 'b-1' is in another project/);
    // A read share is not enough to run it.
    expect(() => load("b-read-share")).toThrow(/another project/);
  });

  it("a run started by a user may call a child that user can execute", () => {
    const { scope, workflows } = scopeFixture();
    expect(scope.dependenciesFor(workflows["a-1"]!, user("builder", "u-runner")).loadWorkflow("b-1")?.id).toBe("b-1");
    expect(() => scope.dependenciesFor(workflows["a-1"]!, user("builder", "u-other")).loadWorkflow("b-1")).toThrow(/another project/);
    // Without a user (webhook, schedule) only the project rules apply.
    expect(() => scope.dependenciesFor(workflows["a-1"]!, null).loadWorkflow("b-1")).toThrow(/another project/);
  });

  it("a workflow without a project counts as the default project when it calls others", () => {
    const { scope, workflows } = scopeFixture();
    expect(() => scope.dependenciesFor(workflows.legacy!).loadWorkflow("a-1")).toThrow(/another project/);
  });

  it("a sub-workflow is scoped to its own project", async () => {
    const { scope, workflows, resolved } = scopeFixture();
    const parent = scope.dependenciesFor(workflows["a-1"]!);
    const child = parent.scopeSubWorkflow(workflows["b-shared"]!);
    // The shared child reads its own project's secret, which the parent could not.
    await expect(parent.resolveSecret({ secretId: "s-b" })).rejects.toThrow(/another project/);
    await expect(child.resolveSecret!({ secretId: "s-b" })).resolves.toBe("value-of-s-b");
    expect(resolved).toEqual(["s-b"]);
    // And its own loader: from pb, a1 is in another project.
    expect(() => child.loadWorkflow!("a-1")).toThrow(/another project/);
    expect(child.loadWorkflow!("b-1")?.id).toBe("b-1");
  });

  it("error workflows follow the same rule and report why they are not run", () => {
    const { scope, workflows } = scopeFixture();
    expect(scope.errorWorkflowFor(workflows["a-1"]!, null, "a-2")).toEqual({ workflow: workflows["a-2"] });
    expect(scope.errorWorkflowFor(workflows["a-1"]!, null, "b-1")).toEqual({ error: expect.stringMatching(/Error workflow 'b-1' is in another project/) });
    expect(scope.errorWorkflowFor(workflows["a-1"]!, null, "nope")).toEqual({ error: "Error workflow 'nope' was not found." });
    expect(scope.errorWorkflowFor(workflows["a-1"]!, user("builder", "u-runner"), "b-1")).toEqual({ workflow: workflows["b-1"] });
  });
});

describe("run scope: secrets", () => {
  it("resolves secrets of the workflow's project, the default project and shares; refuses others", async () => {
    const { scope, workflows, resolved } = scopeFixture();
    const resolve = scope.dependenciesFor(workflows["a-1"]!).resolveSecret;
    await expect(resolve({ secretId: "s-a" })).resolves.toBe("value-of-s-a");
    await expect(resolve({ secretId: "s-default" })).resolves.toBe("value-of-s-default");
    await expect(resolve({ secretId: "s-shared" })).resolves.toBe("value-of-s-shared");
    await expect(resolve({ secretId: "s-b" })).rejects.toThrow("Secret 's-b' belongs to another project and is not shared to this workflow's project.");
    await expect(resolve({ secretId: "unknown" })).resolves.toBeUndefined();
    await expect(resolve(undefined)).resolves.toBeUndefined();
    expect(resolved).toEqual(["s-a", "s-default", "s-shared"]);
  });

  it("needs secret:use for the run's user, except admins", async () => {
    const { scope, workflows } = scopeFixture();
    await expect(scope.dependenciesFor(workflows["a-1"]!, user("operator", "u-no-secrets")).resolveSecret({ secretId: "s-a" })).rejects.toThrow(
      /Permission 'secret:use' is required/
    );
    await expect(scope.dependenciesFor(workflows["a-1"]!, user("admin", "u-no-secrets")).resolveSecret({ secretId: "s-a" })).resolves.toBe("value-of-s-a");
    await expect(scope.dependenciesFor(workflows["a-1"]!, user("builder")).resolveSecret({ secretId: "s-a" })).resolves.toBe("value-of-s-a");
  });
});

describe("run scope: session memory, tool cache and artifacts", () => {
  it("keys every write by project, so two projects never share a namespace", async () => {
    const { scope, workflows, memory } = scopeFixture();
    const a = scope.dependenciesFor(workflows["a-1"]!);
    const b = scope.dependenciesFor(workflows["b-1"]!);
    await a.memoryStore.saveMessages("support", "s1", [{ role: "user", content: "from A" }]);
    expect([...memory.keys()]).toEqual([`${projectSessionNamespace("pa", "support")}|s1`]);
    expect(await b.memoryStore.loadMessages("support", "s1")).toEqual([]);
    expect(await a.memoryStore.loadMessages("support", "s1")).toEqual([{ role: "user", content: "from A" }]);
  });

  it("reads unprefixed rows from before scoping only where they can be this workflow's own", async () => {
    const { scope, workflows, memory } = scopeFixture();
    memory.set("support|s1", [{ role: "user", content: "legacy shared" }]);
    memory.set("b-1:agent|s1", [{ role: "user", content: "legacy of b-1" }]);
    // From another project: neither the shared name nor someone else's default namespace.
    const a = scope.dependenciesFor(workflows["a-1"]!);
    expect(await a.memoryStore.loadMessages("support", "s1")).toEqual([]);
    expect(await a.memoryStore.loadMessages("b-1:agent", "s1")).toEqual([]);
    // The workflow's own default namespace still reads its old memory.
    expect(await scope.dependenciesFor(workflows["b-1"]!).memoryStore.loadMessages("b-1:agent", "s1")).toEqual([{ role: "user", content: "legacy of b-1" }]);
    // Default-project workflows keep reading every legacy row (no change for single-project installs).
    expect(await scope.dependenciesFor(workflows.legacy!).memoryStore.loadMessages("support", "s1")).toEqual([{ role: "user", content: "legacy shared" }]);
  });

  it("scopes the tool cache and artifacts the same way, and reports the caller's namespace", async () => {
    const { scope, workflows, toolCalls } = scopeFixture();
    const a = scope.dependenciesFor(workflows["a-1"]!);
    const b = scope.dependenciesFor(workflows["b-1"]!);
    const saved = await a.toolDataStore.saveToolCall({ namespace: "cache", sessionId: "s1", toolName: "search", args: {}, output: "secret result" });
    expect(saved.namespace).toBe("cache");
    expect(toolCalls[0]!.namespace).toBe(projectSessionNamespace("pa", "cache"));
    expect(await b.toolDataStore.listToolCalls({ namespace: "cache", sessionId: "s1" })).toEqual([]);
    expect(await b.toolDataStore.getToolCall({ namespace: "cache", sessionId: "s1", id: saved.id })).toBeNull();
    expect((await a.toolDataStore.listToolCalls({ namespace: "cache", sessionId: "s1" })).map((row) => row.namespace)).toEqual(["cache"]);
    expect((await a.toolDataStore.getToolCall({ namespace: "cache", sessionId: "s1", id: saved.id }))?.output).toBe("secret result");

    toolCalls.push({ id: "old", namespace: "a-1:agent", sessionId: "s1", toolName: "search", args: {}, output: "legacy", createdAt: "2020-01-01T00:00:00.000Z" });
    expect((await a.toolDataStore.listToolCalls({ namespace: "a-1:agent", sessionId: "s1" })).map((row) => row.id)).toEqual(["old"]);
    expect(await b.toolDataStore.getToolCall({ namespace: "a-1:agent", sessionId: "s1", id: "old" })).toBeNull();

    await a.sessionArtifactStore.saveArtifact({ namespace: "art", sessionId: "s1", artifactKey: "k", value: 42 });
    expect(await b.sessionArtifactStore.loadArtifact({ namespace: "art", sessionId: "s1", artifactKey: "k" })).toBeNull();
    expect(await a.sessionArtifactStore.loadArtifact({ namespace: "art", sessionId: "s1", artifactKey: "k" })).toMatchObject({ namespace: "art", value: 42 });
  });

  it("namespace keys are unambiguous even when project ids contain the separator", () => {
    expect(projectSessionNamespace("x", "y:ns")).not.toBe(projectSessionNamespace("x:y", "ns"));
  });
});
