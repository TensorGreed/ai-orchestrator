import { beforeEach, describe, expect, it } from "vitest";
import {
  LEGACY_ACTIVE_PROJECT_STORAGE_KEY,
  LEGACY_LAST_WORKFLOW_ID_STORAGE_KEY,
  SESSION_ACTIVE_PROJECT_STORAGE_KEY,
  SESSION_LAST_WORKFLOW_ID_STORAGE_KEY,
  buildTabWipStorageKey,
  readRememberedTabProjectId,
  readRememberedTabWorkflowId,
  readStudioUrlState,
  readTabWipWorkflow,
  replaceStudioUrlState,
  preferTabWip,
  storeTabWipWorkflow
} from "./studio-session";
import type { Workflow } from "@ai-orchestrator/shared";

describe("studio-session", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.history.replaceState({}, "", "/");
  });

  it("parses workflow, project, and mode from the URL", () => {
    window.history.replaceState({}, "", "/?workflowId=wf-123&projectId=proj-9&mode=editor");

    expect(readStudioUrlState()).toEqual({
      workflowId: "wf-123",
      projectId: "proj-9",
      mode: "editor"
    });
  });

  it("updates URL state without dropping unrelated query params or hash", () => {
    window.history.replaceState({}, "", "/studio?foo=bar&workflowId=old#canvas");

    replaceStudioUrlState({
      workflowId: "wf-456",
      projectId: "proj-2",
      mode: "chat"
    });

    const params = new URLSearchParams(window.location.search);
    expect(params.get("foo")).toBe("bar");
    expect(params.get("workflowId")).toBe("wf-456");
    expect(params.get("projectId")).toBe("proj-2");
    expect(params.get("mode")).toBe("chat");
    expect(window.location.hash).toBe("#canvas");
  });

  it("stores WIP per workflow in session storage", () => {
    storeTabWipWorkflow(
      {
        id: "wf-a",
        name: "Workflow A",
        schemaVersion: 1,
        workflowVersion: 1,
        nodes: [],
        edges: [],
        pinnedData: { node1: { ok: true } }
      },
      50_000
    );
    storeTabWipWorkflow(
      {
        id: "wf-b",
        name: "Workflow B",
        schemaVersion: 1,
        workflowVersion: 1,
        nodes: [],
        edges: []
      },
      50_000
    );

    expect(readTabWipWorkflow("wf-a", 50_000)?.id).toBe("wf-a");
    expect(readTabWipWorkflow("wf-b", 50_000)?.id).toBe("wf-b");

    const raw = window.sessionStorage.getItem(buildTabWipStorageKey("wf-a"));
    expect(raw).toContain("\"id\":\"wf-a\"");
    expect(raw).not.toContain("pinnedData");
  });

  it("prefers session-scoped workflow and project ids over legacy local storage", () => {
    window.localStorage.setItem(LEGACY_LAST_WORKFLOW_ID_STORAGE_KEY, "wf-local");
    window.localStorage.setItem(LEGACY_ACTIVE_PROJECT_STORAGE_KEY, "proj-local");
    window.sessionStorage.setItem(SESSION_LAST_WORKFLOW_ID_STORAGE_KEY, "wf-session");
    window.sessionStorage.setItem(SESSION_ACTIVE_PROJECT_STORAGE_KEY, "proj-session");

    expect(readRememberedTabWorkflowId()).toBe("wf-session");
    expect(readRememberedTabProjectId()).toBe("proj-session");
  });
});

describe("preferTabWip", () => {
  const workflowWith = (nodeCount: number, name = "Workflow 6"): Workflow => ({
    id: "wf-6",
    name,
    schemaVersion: "1.0.0",
    workflowVersion: 1,
    nodes: Array.from({ length: nodeCount }, (_, index) => ({
      id: `n${index}`,
      type: "text_input",
      name: `Node ${index}`,
      position: { x: index * 100, y: 0 },
      config: {}
    })),
    edges: []
  });

  it("opens the server copy when the tab copy is an empty canvas but the server has nodes", () => {
    const server = workflowWith(6);
    expect(preferTabWip(workflowWith(0), server)).toBe(server);
  });

  it("keeps the tab's unsaved work otherwise", () => {
    const edited = workflowWith(2, "Workflow 6 (edited)");
    expect(preferTabWip(edited, workflowWith(6))).toBe(edited);
    const emptyBoth = workflowWith(0, "still empty");
    expect(preferTabWip(emptyBoth, workflowWith(0))).toBe(emptyBoth);
  });

  it("opens the server copy when there is no tab copy", () => {
    const server = workflowWith(3);
    expect(preferTabWip(null, server)).toBe(server);
  });
});
