import type { ChangeEvent, RefObject } from "react";
import type { WorkflowListItem } from "@ai-orchestrator/shared";
import type { AuthUser } from "../lib/api";
import type { EdgePathMode, StudioMode } from "./studio-layout-types";

interface TopBarProps {
  activeMode: StudioMode;
  canManageSecrets: boolean;
  currentWorkflowName: string;
  currentWorkflowId: string;
  currentWorkflowExists: boolean;
  workflowList: WorkflowListItem[];
  authUser: AuthUser;
  busy: boolean;
  secretBusy: boolean;
  edgePathMode: EdgePathMode;
  importFileRef: RefObject<HTMLInputElement | null>;
  onWorkflowNameChange: (name: string) => void;
  onLoadWorkflowById: (id: string) => void;
  onModeChange: (mode: StudioMode) => void;
  onSave: () => void;
  onExport: () => void;
  onImportClick: () => void;
  onImportFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onEdgePathModeChange: (mode: EdgePathMode) => void;
  onRefreshSecrets: () => void;
  onLogout: () => void;
}

export function TopBar({
  activeMode,
  canManageSecrets,
  currentWorkflowName,
  currentWorkflowId,
  currentWorkflowExists,
  workflowList,
  authUser,
  busy,
  secretBusy,
  edgePathMode,
  importFileRef,
  onWorkflowNameChange,
  onLoadWorkflowById,
  onModeChange,
  onSave,
  onExport,
  onImportClick,
  onImportFileChange,
  onEdgePathModeChange,
  onRefreshSecrets,
  onLogout
}: TopBarProps) {
  return (
    <header className="top-header">
      <div className="header-left">
        <span className="crumbs">Personal /</span>
        <input
          className="workflow-name-input"
          value={currentWorkflowName}
          onChange={(event) => onWorkflowNameChange(event.target.value)}
        />
        <select
          className="workflow-select"
          value={currentWorkflowExists ? currentWorkflowId : ""}
          onChange={(event) => {
            const selectedId = event.target.value;
            if (selectedId) {
              onLoadWorkflowById(selectedId);
            }
          }}
        >
          {!currentWorkflowExists && <option value="">Current (unsaved)</option>}
          {workflowList.map((workflow) => (
            <option key={workflow.id} value={workflow.id}>
              {workflow.name}
            </option>
          ))}
        </select>
      </div>

      <div className="header-actions">
        <div className="auth-user-pill" title={authUser.email}>
          <span>{authUser.email}</span>
          <strong>{authUser.role}</strong>
        </div>
        {(activeMode === "editor" || activeMode === "executions" || activeMode === "evaluations") && (
          <>
            <button className="header-btn" onClick={onSave} disabled={busy}>
              Save
            </button>
            <button className="header-btn" onClick={onExport}>
              Export
            </button>
            <button className="header-btn" onClick={onImportClick}>
              Import
            </button>
          </>
        )}
        {activeMode === "editor" && (
          <select
            className="workflow-select edge-mode-select"
            value={edgePathMode}
            onChange={(event) => onEdgePathModeChange(event.target.value as EdgePathMode)}
            title="Edge path style"
          >
            <option value="bezier">Curved Edges</option>
            <option value="smoothstep">Stepped Edges</option>
          </select>
        )}
        {activeMode === "secrets" && canManageSecrets && (
          <button className="header-btn" onClick={onRefreshSecrets} disabled={secretBusy || busy}>
            Refresh Secrets
          </button>
        )}
        <button className="header-btn" onClick={onLogout}>
          Logout
        </button>
        <input ref={importFileRef} type="file" accept="application/json" hidden onChange={onImportFileChange} />
      </div>
    </header>
  );
}
