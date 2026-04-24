import type { Workflow } from "@ai-orchestrator/shared";
import type { StudioMode } from "../components/studio-layout-types";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type LocationLike = Pick<Location, "pathname" | "search" | "hash">;
type HistoryLike = Pick<History, "replaceState">;

const STUDIO_MODES: StudioMode[] = [
  "dashboard",
  "editor",
  "templates",
  "variables",
  "executions",
  "chat",
  "evaluations",
  "secrets",
  "settings"
];

export const LEGACY_LOCAL_WIP_WORKFLOW_STORAGE_KEY = "ai-orchestrator:wip-workflow";
export const LEGACY_LAST_WORKFLOW_ID_STORAGE_KEY = "ai-orchestrator:last-workflow-id";
export const LEGACY_ACTIVE_PROJECT_STORAGE_KEY = "ai-orchestrator:active-project";

export const SESSION_LAST_WORKFLOW_ID_STORAGE_KEY = "ai-orchestrator:session:last-workflow-id";
export const SESSION_ACTIVE_PROJECT_STORAGE_KEY = "ai-orchestrator:session:active-project";
export const SESSION_WIP_WORKFLOW_STORAGE_PREFIX = "ai-orchestrator:session:wip:";

export const STUDIO_URL_WORKFLOW_ID_PARAM = "workflowId";
export const STUDIO_URL_PROJECT_ID_PARAM = "projectId";
export const STUDIO_URL_MODE_PARAM = "mode";

function normalizeValue(value: string | null | undefined): string | null {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed : null;
}

function safeGetItem(storage: StorageLike | undefined, key: string): string | null {
  if (!storage) {
    return null;
  }
  try {
    return storage.getItem(key);
  } catch {
    return null;
  }
}

function safeSetItem(storage: StorageLike | undefined, key: string, value: string): void {
  if (!storage) {
    return;
  }
  try {
    storage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

function safeRemoveItem(storage: StorageLike | undefined, key: string): void {
  if (!storage) {
    return;
  }
  try {
    storage.removeItem(key);
  } catch {
    /* ignore */
  }
}

function isWorkflowShape(value: unknown): value is Workflow {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as Workflow).id === "string" &&
      Array.isArray((value as Workflow).nodes) &&
      Array.isArray((value as Workflow).edges)
  );
}

function parseStoredWorkflow(raw: string | null, maxChars: number): Workflow | null {
  if (!raw || raw.length > maxChars) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Workflow;
    return isWorkflowShape(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function withoutPinnedData(workflow: Workflow): Workflow {
  const next: Workflow = { ...workflow };
  delete next.pinnedData;
  return next;
}

export function isStudioMode(value: string | null | undefined): value is StudioMode {
  return STUDIO_MODES.includes(String(value ?? "").trim() as StudioMode);
}

export function buildTabWipStorageKey(workflowId: string): string {
  return `${SESSION_WIP_WORKFLOW_STORAGE_PREFIX}${workflowId.trim()}`;
}

export function readStudioUrlState(
  locationLike: Pick<LocationLike, "search"> | undefined = typeof window !== "undefined" ? window.location : undefined
): { workflowId: string | null; projectId: string | null; mode: StudioMode | null } {
  const params = new URLSearchParams(locationLike?.search ?? "");
  const workflowId = normalizeValue(params.get(STUDIO_URL_WORKFLOW_ID_PARAM));
  const projectId = normalizeValue(params.get(STUDIO_URL_PROJECT_ID_PARAM));
  const modeRaw = normalizeValue(params.get(STUDIO_URL_MODE_PARAM));

  return {
    workflowId,
    projectId,
    mode: isStudioMode(modeRaw) ? modeRaw : null
  };
}

export function replaceStudioUrlState(
  input: { workflowId?: string | null; projectId?: string | null; mode?: StudioMode | null },
  deps: {
    location?: LocationLike;
    history?: HistoryLike;
  } = {}
): void {
  const locationLike = deps.location ?? (typeof window !== "undefined" ? window.location : undefined);
  const historyLike = deps.history ?? (typeof window !== "undefined" ? window.history : undefined);
  if (!locationLike || !historyLike) {
    return;
  }

  try {
    const params = new URLSearchParams(locationLike.search);
    const workflowId = normalizeValue(input.workflowId);
    const projectId = normalizeValue(input.projectId);
    const mode = input.mode && isStudioMode(input.mode) ? input.mode : null;

    if (workflowId) {
      params.set(STUDIO_URL_WORKFLOW_ID_PARAM, workflowId);
    } else {
      params.delete(STUDIO_URL_WORKFLOW_ID_PARAM);
    }

    if (projectId) {
      params.set(STUDIO_URL_PROJECT_ID_PARAM, projectId);
    } else {
      params.delete(STUDIO_URL_PROJECT_ID_PARAM);
    }

    if (mode) {
      params.set(STUDIO_URL_MODE_PARAM, mode);
    } else {
      params.delete(STUDIO_URL_MODE_PARAM);
    }

    const query = params.toString();
    const nextUrl = `${locationLike.pathname}${query ? `?${query}` : ""}${locationLike.hash ?? ""}`;
    historyLike.replaceState(null, "", nextUrl);
  } catch {
    /* ignore */
  }
}

export function rememberTabWorkflowId(
  workflowId: string,
  deps: {
    sessionStorage?: StorageLike;
    localStorage?: StorageLike;
  } = {}
): void {
  const normalized = normalizeValue(workflowId);
  if (!normalized) {
    return;
  }

  const sessionStorageLike = deps.sessionStorage ?? (typeof window !== "undefined" ? window.sessionStorage : undefined);
  const localStorageLike = deps.localStorage ?? (typeof window !== "undefined" ? window.localStorage : undefined);
  safeSetItem(sessionStorageLike, SESSION_LAST_WORKFLOW_ID_STORAGE_KEY, normalized);
  safeSetItem(localStorageLike, LEGACY_LAST_WORKFLOW_ID_STORAGE_KEY, normalized);
}

export function readRememberedTabWorkflowId(
  deps: {
    sessionStorage?: StorageLike;
    localStorage?: StorageLike;
  } = {}
): string | null {
  const sessionStorageLike = deps.sessionStorage ?? (typeof window !== "undefined" ? window.sessionStorage : undefined);
  const localStorageLike = deps.localStorage ?? (typeof window !== "undefined" ? window.localStorage : undefined);

  return (
    normalizeValue(safeGetItem(sessionStorageLike, SESSION_LAST_WORKFLOW_ID_STORAGE_KEY)) ??
    normalizeValue(safeGetItem(localStorageLike, LEGACY_LAST_WORKFLOW_ID_STORAGE_KEY))
  );
}

export function rememberTabProjectId(
  projectId: string,
  deps: {
    sessionStorage?: StorageLike;
    localStorage?: StorageLike;
  } = {}
): void {
  const normalized = normalizeValue(projectId);
  if (!normalized) {
    return;
  }

  const sessionStorageLike = deps.sessionStorage ?? (typeof window !== "undefined" ? window.sessionStorage : undefined);
  const localStorageLike = deps.localStorage ?? (typeof window !== "undefined" ? window.localStorage : undefined);
  safeSetItem(sessionStorageLike, SESSION_ACTIVE_PROJECT_STORAGE_KEY, normalized);
  safeSetItem(localStorageLike, LEGACY_ACTIVE_PROJECT_STORAGE_KEY, normalized);
}

export function readRememberedTabProjectId(
  deps: {
    sessionStorage?: StorageLike;
    localStorage?: StorageLike;
  } = {}
): string | null {
  const sessionStorageLike = deps.sessionStorage ?? (typeof window !== "undefined" ? window.sessionStorage : undefined);
  const localStorageLike = deps.localStorage ?? (typeof window !== "undefined" ? window.localStorage : undefined);

  return (
    normalizeValue(safeGetItem(sessionStorageLike, SESSION_ACTIVE_PROJECT_STORAGE_KEY)) ??
    normalizeValue(safeGetItem(localStorageLike, LEGACY_ACTIVE_PROJECT_STORAGE_KEY))
  );
}

export function storeTabWipWorkflow(
  workflow: Workflow,
  maxChars: number,
  deps: {
    sessionStorage?: StorageLike;
  } = {}
): void {
  const workflowId = normalizeValue(workflow.id);
  if (!workflowId) {
    return;
  }

  const sessionStorageLike = deps.sessionStorage ?? (typeof window !== "undefined" ? window.sessionStorage : undefined);
  const key = buildTabWipStorageKey(workflowId);

  try {
    const serialized = JSON.stringify(withoutPinnedData(workflow));
    if (serialized.length > maxChars) {
      safeRemoveItem(sessionStorageLike, key);
      return;
    }
    safeSetItem(sessionStorageLike, key, serialized);
  } catch {
    safeRemoveItem(sessionStorageLike, key);
  }
}

export function readTabWipWorkflow(
  workflowId: string,
  maxChars: number,
  deps: {
    sessionStorage?: StorageLike;
  } = {}
): Workflow | null {
  const normalized = normalizeValue(workflowId);
  if (!normalized) {
    return null;
  }

  const sessionStorageLike = deps.sessionStorage ?? (typeof window !== "undefined" ? window.sessionStorage : undefined);
  const key = buildTabWipStorageKey(normalized);
  const raw = safeGetItem(sessionStorageLike, key);
  const parsed = parseStoredWorkflow(raw, maxChars);
  if (!parsed && raw) {
    safeRemoveItem(sessionStorageLike, key);
  }
  return parsed;
}

export function deleteTabWipWorkflow(
  workflowId: string,
  deps: {
    sessionStorage?: StorageLike;
  } = {}
): void {
  const normalized = normalizeValue(workflowId);
  if (!normalized) {
    return;
  }

  const sessionStorageLike = deps.sessionStorage ?? (typeof window !== "undefined" ? window.sessionStorage : undefined);
  safeRemoveItem(sessionStorageLike, buildTabWipStorageKey(normalized));
}

export function readLegacyLocalWipWorkflow(
  maxChars: number,
  deps: {
    localStorage?: StorageLike;
  } = {}
): Workflow | null {
  const localStorageLike = deps.localStorage ?? (typeof window !== "undefined" ? window.localStorage : undefined);
  const raw = safeGetItem(localStorageLike, LEGACY_LOCAL_WIP_WORKFLOW_STORAGE_KEY);
  const parsed = parseStoredWorkflow(raw, maxChars);
  if (!parsed && raw) {
    safeRemoveItem(localStorageLike, LEGACY_LOCAL_WIP_WORKFLOW_STORAGE_KEY);
  }
  return parsed;
}
