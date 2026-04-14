import { useEffect, useMemo, useRef, useState, type ChangeEvent, type RefObject } from "react";
import type { WorkflowListItem } from "@ai-orchestrator/shared";
import type { AuthUser } from "../lib/api";
import type { StudioMode } from "./studio-layout-types";

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
  importFileRef: RefObject<HTMLInputElement | null>;
  onWorkflowNameChange: (name: string) => void;
  onLoadWorkflowById: (id: string) => void;
  onModeChange: (mode: StudioMode) => void;
  onSave: () => void;
  onExport: () => void;
  onImportClick: () => void;
  onImportFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onRefreshSecrets: () => void;
  onLogout: () => void;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  onOpenShortcuts: () => void;
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
  importFileRef,
  onWorkflowNameChange,
  onLoadWorkflowById,
  onModeChange,
  onSave,
  onExport,
  onImportClick,
  onImportFileChange,
  onRefreshSecrets,
  onLogout,
  theme,
  onToggleTheme,
  onOpenShortcuts
}: TopBarProps) {
  const [isAccountMenuOpen, setIsAccountMenuOpen] = useState(false);
  const accountMenuRef = useRef<HTMLDivElement>(null);
  const displayName = useMemo(() => authUser.email.split("@")[0] || authUser.email, [authUser.email]);
  const docsUrl = useMemo(() => {
    const fromEnv = (import.meta.env.VITE_DOCS_URL as string | undefined)?.trim();
    if (fromEnv) {
      return fromEnv;
    }

    if (typeof window !== "undefined") {
      return `${window.location.protocol}//${window.location.hostname}:4173`;
    }

    return "http://localhost:4173";
  }, []);

  useEffect(() => {
    const handleOutsideClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (!accountMenuRef.current?.contains(target)) {
        setIsAccountMenuOpen(false);
      }
    };

    document.addEventListener("mousedown", handleOutsideClick);
    return () => {
      document.removeEventListener("mousedown", handleOutsideClick);
    };
  }, []);

  return (
    <header className="top-header">
      <div className="header-left">
        <div className="brand-badge">
          <img src="/lsquarem-logo.svg" alt="L2M logo" className="brand-badge-logo" />
          <div className="brand-badge-copy">
            <strong>
              L<sup>2</sup>M
            </strong>
            <span>STUDIO</span>
          </div>
        </div>
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

      <div className="header-tabs" role="tablist" aria-label="Studio modes">
        <button
          className={activeMode === "dashboard" ? "tab active" : "tab"}
          type="button"
          onClick={() => onModeChange("dashboard")}
        >
          Dashboard
        </button>
        <button
          className={activeMode === "editor" ? "tab active" : "tab"}
          type="button"
          onClick={() => onModeChange("editor")}
        >
          Editor
        </button>
        <button
          className={activeMode === "variables" ? "tab active" : "tab"}
          type="button"
          onClick={() => onModeChange("variables")}
        >
          Variables
        </button>
        <button
          className={activeMode === "executions" ? "tab active" : "tab"}
          type="button"
          onClick={() => onModeChange("executions")}
        >
          Runs
        </button>
        <button
          className={activeMode === "chat" ? "tab active" : "tab"}
          type="button"
          onClick={() => onModeChange("chat")}
        >
          Chat
        </button>
        <button
          className={activeMode === "evaluations" ? "tab active" : "tab"}
          type="button"
          onClick={() => onModeChange("evaluations")}
        >
          Eval
        </button>
        {canManageSecrets && (
          <button
            className={activeMode === "secrets" ? "tab active" : "tab"}
            type="button"
            onClick={() => onModeChange("secrets")}
          >
            Secrets
          </button>
        )}
      </div>

      <div className="header-actions">
        <button
          className="header-btn icon-only"
          onClick={onToggleTheme}
          title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          aria-label="Toggle theme"
        >
          {theme === "dark" ? "☀" : "☾"}
        </button>
        <button
          className="header-btn icon-only"
          onClick={onOpenShortcuts}
          title="Keyboard shortcuts (?)"
          aria-label="Keyboard shortcuts"
        >
          ?
        </button>
        <a className="header-btn header-link-btn" href={docsUrl} target="_blank" rel="noreferrer">
          Docs
        </a>
        {(activeMode === "editor" ||
          activeMode === "variables" ||
          activeMode === "executions" ||
          activeMode === "chat" ||
          activeMode === "evaluations") && (
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
        {activeMode === "secrets" && canManageSecrets && (
          <button className="header-btn" onClick={onRefreshSecrets} disabled={secretBusy || busy}>
            Refresh Secrets
          </button>
        )}
        <div className="account-menu" ref={accountMenuRef}>
          <button
            className="account-trigger"
            onClick={() => setIsAccountMenuOpen((value) => !value)}
            aria-haspopup="menu"
            aria-expanded={isAccountMenuOpen}
            title={authUser.email}
          >
            <span className="account-name">{displayName}</span>
            <span className="account-caret">&#9662;</span>
          </button>
          {isAccountMenuOpen && (
            <div className="account-dropdown" role="menu">
              <div className="account-email">{authUser.email}</div>
              <button
                className="account-logout"
                role="menuitem"
                onClick={() => {
                  setIsAccountMenuOpen(false);
                  onLogout();
                }}
              >
                Logout
              </button>
            </div>
          )}
        </div>
        <input ref={importFileRef} type="file" accept="application/json" hidden onChange={onImportFileChange} />
      </div>
    </header>
  );
}
