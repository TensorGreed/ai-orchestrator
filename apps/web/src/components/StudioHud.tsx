import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type RefObject } from "react";
import type { Project, WorkflowListItem } from "@ai-orchestrator/shared";
import type { AuthUser } from "../lib/api";
import { CommandPalette } from "./CommandPalette";
import { DocsIcon, HelpIcon, MoonIcon, MoreIcon, PlayIcon, SunIcon } from "./shell-icons";
import { STUDIO_MODE_ITEMS, type CommandPaletteItem, type RunStatus, type StudioMode } from "./studio-layout-types";

export interface StudioHudProps {
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
  /** Opens the import-from-another-builder dialog; omitted for roles that cannot create workflows. */
  onImportExternal?: () => void;
  onRefreshSecrets: () => void;
  onLogout: () => void;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  onOpenShortcuts: () => void;
  projects: Project[];
  activeProjectId: string;
  onChangeActiveProject: (projectId: string) => void;
  onCreateProject: () => void;
  /** Run-status pill content. */
  runStatus?: RunStatus;
  /** Primary "Run" action; rendered in editor mode only. */
  onRun?: () => void;
  /** Shows the unsaved dot on the Save pill. */
  isDirty?: boolean;
  /** Opens the editor's share dialog from the overflow menu. */
  onShare?: () => void;
  /** Additional command palette entries (e.g. "add node" items from the canvas). */
  extraItems?: CommandPaletteItem[];
  /** Optional docs URL override; defaults to VITE_DOCS_URL or host:4173. */
  docsUrl?: string;
}

const NO_EXTRA_ITEMS: CommandPaletteItem[] = [];

function resolveDocsUrl(override?: string): string {
  if (override) return override;
  const fromEnv = (import.meta.env.VITE_DOCS_URL as string | undefined)?.trim();
  if (fromEnv) return fromEnv;
  if (typeof window !== "undefined") {
    return `${window.location.protocol}//${window.location.hostname}:4173`;
  }
  return "http://localhost:4173";
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

export function StudioHud({
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
  onImportExternal,
  onRefreshSecrets,
  onLogout,
  theme,
  onToggleTheme,
  onOpenShortcuts,
  projects,
  activeProjectId,
  onChangeActiveProject,
  onCreateProject,
  runStatus,
  onRun,
  isDirty = false,
  onShare,
  extraItems = NO_EXTRA_ITEMS,
  docsUrl
}: StudioHudProps) {
  const [accountOpen, setAccountOpen] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const accountRef = useRef<HTMLDivElement>(null);
  const overflowRef = useRef<HTMLDivElement>(null);

  const displayName = useMemo(() => authUser.email.split("@")[0] || authUser.email, [authUser.email]);
  const resolvedDocsUrl = useMemo(() => resolveDocsUrl(docsUrl), [docsUrl]);
  const activeProject = projects.find((project) => project.id === activeProjectId);
  const isEditor = activeMode === "editor";
  const showWorkflowActions =
    activeMode === "editor" ||
    activeMode === "variables" ||
    activeMode === "executions" ||
    activeMode === "chat" ||
    activeMode === "evaluations";

  useEffect(() => {
    const handleOutsideClick = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (!accountRef.current?.contains(target)) setAccountOpen(false);
      if (!overflowRef.current?.contains(target)) setOverflowOpen(false);
    };
    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((value) => !value);
        return;
      }
      if (event.key === "Escape" && (accountOpen || overflowOpen) && !isEditableTarget(event.target)) {
        setAccountOpen(false);
        setOverflowOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [accountOpen, overflowOpen]);

  const closePalette = useCallback(() => setPaletteOpen(false), []);

  const openDocs = useCallback(() => {
    window.open(resolvedDocsUrl, "_blank", "noopener,noreferrer");
  }, [resolvedDocsUrl]);

  const paletteItems = useMemo<CommandPaletteItem[]>(() => {
    const items: CommandPaletteItem[] = [];
    if (isEditor && onRun) {
      items.push({ id: "run", label: "Run workflow", group: "Actions", hint: "Run ▸", run: onRun });
    }
    if (showWorkflowActions) {
      items.push({ id: "save", label: "Save workflow", group: "Actions", hint: "⌘S", run: onSave });
      items.push({ id: "export", label: "Export workflow JSON", group: "Actions", run: onExport });
      items.push({ id: "import", label: "Import workflow JSON", group: "Actions", run: onImportClick });
      if (onImportExternal) {
        items.push({ id: "import-external", label: "Import from another builder", group: "Actions", run: onImportExternal });
      }
      if (onShare) items.push({ id: "share", label: "Share workflow", group: "Actions", run: onShare });
    }
    if (activeMode === "secrets" && canManageSecrets) {
      items.push({ id: "refresh-secrets", label: "Refresh secrets", group: "Actions", run: onRefreshSecrets });
    }
    for (const item of STUDIO_MODE_ITEMS) {
      if (item.adminOnly && !canManageSecrets) continue;
      items.push({
        id: `mode-${item.mode}`,
        label: `Go to ${item.label}`,
        group: "Navigate",
        run: () => onModeChange(item.mode)
      });
    }
    for (const workflow of workflowList) {
      items.push({
        id: `wf-${workflow.id}`,
        label: `Open ${workflow.name}`,
        group: "Workflows",
        hint: workflow.id,
        run: () => onLoadWorkflowById(workflow.id)
      });
    }
    items.push({
      id: "theme",
      label: theme === "dark" ? "Switch to light theme" : "Switch to dark theme",
      group: "Preferences",
      run: onToggleTheme
    });
    items.push({ id: "docs", label: "Open documentation", group: "Help", run: openDocs });
    items.push({ id: "shortcuts", label: "Keyboard shortcuts", group: "Help", hint: "?", run: onOpenShortcuts });
    return [...extraItems, ...items];
  }, [
    activeMode,
    canManageSecrets,
    extraItems,
    isEditor,
    onExport,
    onImportClick,
    onImportExternal,
    onLoadWorkflowById,
    onModeChange,
    onOpenShortcuts,
    onRefreshSecrets,
    onRun,
    onSave,
    onShare,
    onToggleTheme,
    openDocs,
    showWorkflowActions,
    theme,
    workflowList
  ]);

  const status = runStatus ?? { state: "idle" as const, label: "no runs yet" };

  return (
    <header className="hud" role="banner">
      <div className="hud-left">
        <div className="hud-pill hud-breadcrumb" title={activeProject ? `Project: ${activeProject.name}` : undefined}>
          <span className="hud-crumb hud-crumb-project">{activeProject?.name ?? "Project"}</span>
          <span className="hud-crumb-sep" aria-hidden="true">
            /
          </span>
          {isEditor && (
            <input
              className="hud-workflow-name"
              aria-label="Workflow name"
              value={currentWorkflowName}
              onChange={(event) => onWorkflowNameChange(event.target.value)}
              spellCheck={false}
            />
          )}
          <select
            className={isEditor ? "hud-workflow-select is-compact" : "hud-workflow-select is-crumb"}
            aria-label="Workflow"
            title="Switch workflow"
            value={currentWorkflowExists ? currentWorkflowId : ""}
            onChange={(event) => {
              const selectedId = event.target.value;
              if (selectedId) onLoadWorkflowById(selectedId);
            }}
          >
            {!currentWorkflowExists && <option value="">{currentWorkflowName || "Current (unsaved)"}</option>}
            {workflowList.map((workflow) => (
              <option key={workflow.id} value={workflow.id}>
                {workflow.name}
              </option>
            ))}
          </select>
        </div>

        <div className={`hud-pill hud-run-status is-${status.state}`} role="status" aria-live="polite">
          <span className="hud-dot" aria-hidden="true" />
          <span className="hud-run-label">{status.label}</span>
        </div>
      </div>

      <div className="hud-right">
        <button
          type="button"
          className="hud-pill hud-btn hud-cmdk"
          onClick={() => setPaletteOpen(true)}
          title="Command palette (⌘K / Ctrl+K)"
          aria-label="Open command palette"
          aria-haspopup="dialog"
        >
          <kbd>⌘K</kbd>
        </button>
        <button
          type="button"
          className="hud-pill hud-btn hud-icon-btn"
          onClick={onToggleTheme}
          title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          aria-label="Toggle theme"
        >
          {theme === "dark" ? <SunIcon /> : <MoonIcon />}
        </button>
        <button
          type="button"
          className="hud-pill hud-btn hud-icon-btn"
          onClick={onOpenShortcuts}
          title="Keyboard shortcuts (?)"
          aria-label="Keyboard shortcuts"
        >
          <HelpIcon />
        </button>
        <a
          className="hud-pill hud-btn hud-icon-btn"
          href={resolvedDocsUrl}
          target="_blank"
          rel="noreferrer"
          title="Documentation"
          aria-label="Documentation"
        >
          <DocsIcon />
        </a>

        <div className="hud-menu" ref={accountRef}>
          <button
            type="button"
            className="hud-pill hud-btn hud-account"
            onClick={() => setAccountOpen((value) => !value)}
            aria-haspopup="menu"
            aria-expanded={accountOpen}
            title={authUser.email}
          >
            <span className="hud-avatar" aria-hidden="true">
              {displayName.slice(0, 1).toUpperCase()}
            </span>
            <span className="hud-account-name">{displayName}</span>
          </button>
          {accountOpen && (
            <div className="hud-dropdown" role="menu">
              <div className="hud-dropdown-email">{authUser.email}</div>
              <button
                type="button"
                className="hud-dropdown-item"
                role="menuitem"
                onClick={() => {
                  setAccountOpen(false);
                  onModeChange("settings");
                }}
              >
                Account settings
              </button>
              <button
                type="button"
                className="hud-dropdown-item is-danger"
                role="menuitem"
                onClick={() => {
                  setAccountOpen(false);
                  onLogout();
                }}
              >
                Logout
              </button>
            </div>
          )}
        </div>

        {showWorkflowActions && (
          <button
            type="button"
            className={isDirty ? "hud-pill hud-btn hud-save is-dirty" : "hud-pill hud-btn hud-save"}
            onClick={onSave}
            disabled={busy}
            title={isDirty ? "Save (unsaved changes)" : "Save"}
          >
            <span>Save</span>
            {isDirty && <span className="hud-dirty-dot" aria-label="Unsaved changes" />}
          </button>
        )}

        {activeMode === "secrets" && canManageSecrets && (
          <button type="button" className="hud-pill hud-btn" onClick={onRefreshSecrets} disabled={secretBusy || busy}>
            Refresh secrets
          </button>
        )}

        {isEditor && (
          <div className="hud-menu" ref={overflowRef}>
            <button
              type="button"
              className="hud-pill hud-btn hud-icon-btn"
              onClick={() => setOverflowOpen((value) => !value)}
              aria-haspopup="menu"
              aria-expanded={overflowOpen}
              aria-label="More actions"
              title="More actions"
            >
              <MoreIcon />
            </button>
            {overflowOpen && (
              <div className="hud-dropdown" role="menu">
                <button
                  type="button"
                  className="hud-dropdown-item"
                  role="menuitem"
                  onClick={() => {
                    setOverflowOpen(false);
                    onExport();
                  }}
                >
                  Export JSON
                </button>
                <button
                  type="button"
                  className="hud-dropdown-item"
                  role="menuitem"
                  onClick={() => {
                    setOverflowOpen(false);
                    onImportClick();
                  }}
                >
                  Import JSON
                </button>
                {onImportExternal && (
                  <button
                    type="button"
                    className="hud-dropdown-item"
                    role="menuitem"
                    onClick={() => {
                      setOverflowOpen(false);
                      onImportExternal();
                    }}
                  >
                    Import from another builder…
                  </button>
                )}
                {onShare && (
                  <button
                    type="button"
                    className="hud-dropdown-item"
                    role="menuitem"
                    onClick={() => {
                      setOverflowOpen(false);
                      onShare();
                    }}
                  >
                    Share…
                  </button>
                )}
                {canManageSecrets && (
                  <button
                    type="button"
                    className="hud-dropdown-item"
                    role="menuitem"
                    disabled={secretBusy || busy}
                    onClick={() => {
                      setOverflowOpen(false);
                      onRefreshSecrets();
                    }}
                  >
                    Refresh secrets
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {isEditor && onRun && (
          <button
            type="button"
            className="hud-pill hud-run"
            onClick={onRun}
            disabled={busy}
            title="Run workflow"
            aria-label="Run workflow"
          >
            <span>Run</span>
            <PlayIcon />
          </button>
        )}

        <input ref={importFileRef} type="file" accept="application/json" hidden onChange={onImportFileChange} />
      </div>

      <CommandPalette open={paletteOpen} items={paletteItems} onClose={closePalette} />
    </header>
  );
}
