import { useCallback, useEffect, useState } from "react";
import type { Project } from "@ai-orchestrator/shared";
import { CollapseIcon, ExpandIcon, MODE_ICONS, PlusIcon, ProductMark } from "./shell-icons";
import { STUDIO_MODE_ITEMS, type StudioMode } from "./studio-layout-types";

export const SIDEBAR_COLLAPSED_STORAGE_KEY = "l2m:sidebar-collapsed";

export function readSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeSidebarCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, collapsed ? "1" : "0");
  } catch {
    /* localStorage can be unavailable in private mode; the state still works for this session. */
  }
}

export interface AppSidebarProps {
  activeMode: StudioMode;
  canManageSecrets: boolean;
  onModeChange: (mode: StudioMode) => void;
  projects?: Project[];
  activeProjectId?: string;
  onChangeActiveProject?: (projectId: string) => void;
  onCreateProject?: () => void;
  /** Lets App observe the collapsed state (e.g. for layout tests); optional. */
  onCollapsedChange?: (collapsed: boolean) => void;
}

export function AppSidebar({
  activeMode,
  canManageSecrets,
  onModeChange,
  projects,
  activeProjectId,
  onChangeActiveProject,
  onCreateProject,
  onCollapsedChange
}: AppSidebarProps) {
  const [collapsed, setCollapsed] = useState<boolean>(readSidebarCollapsed);

  useEffect(() => {
    writeSidebarCollapsed(collapsed);
    onCollapsedChange?.(collapsed);
  }, [collapsed, onCollapsedChange]);

  const toggleCollapsed = useCallback(() => setCollapsed((value) => !value), []);

  const items = STUDIO_MODE_ITEMS.filter((item) => !item.adminOnly || canManageSecrets);
  const activeProject = projects?.find((project) => project.id === activeProjectId);
  const showProjects = Boolean(projects && onChangeActiveProject);

  return (
    <aside className={collapsed ? "app-sidebar is-collapsed" : "app-sidebar"} data-collapsed={collapsed ? "true" : "false"}>
      <div className="sidebar-brand">
        <ProductMark compact={collapsed} />
      </div>

      {showProjects && (
        <div className="sidebar-project" title={activeProject ? `Project: ${activeProject.name}` : "Project"}>
          <label className="sidebar-project-label" htmlFor="sidebar-project-select">
            Project
          </label>
          <div className="sidebar-project-row">
            <select
              id="sidebar-project-select"
              className="sidebar-project-select"
              aria-label="Project"
              value={activeProjectId ?? ""}
              onChange={(event) => {
                const value = event.target.value;
                if (value === "__new__") {
                  onCreateProject?.();
                  return;
                }
                onChangeActiveProject?.(value);
              }}
            >
              {projects?.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
              {onCreateProject && (
                <>
                  <option disabled>──────────</option>
                  <option value="__new__">+ New project…</option>
                </>
              )}
            </select>
            {onCreateProject && (
              <button
                type="button"
                className="sidebar-icon-btn"
                onClick={onCreateProject}
                title="New project"
                aria-label="New project"
              >
                <PlusIcon />
              </button>
            )}
          </div>
        </div>
      )}

      <nav className="sidebar-nav" aria-label="Workspace">
        <div className="sidebar-section-title">Workspace</div>
        <ul className="sidebar-list">
          {items.map((item) => {
            const Icon = MODE_ICONS[item.mode];
            const active = item.mode === activeMode;
            return (
              <li key={item.mode}>
                <button
                  type="button"
                  className={active ? "sidebar-item is-active" : "sidebar-item"}
                  onClick={() => onModeChange(item.mode)}
                  aria-current={active ? "page" : undefined}
                  title={item.label}
                >
                  <span className="sidebar-item-icon">
                    <Icon />
                  </span>
                  <span className="sidebar-item-label">{item.label}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="sidebar-foot">
        <button
          type="button"
          className="sidebar-item sidebar-toggle"
          onClick={toggleCollapsed}
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
        >
          <span className="sidebar-item-icon">{collapsed ? <ExpandIcon /> : <CollapseIcon />}</span>
          <span className="sidebar-item-label">Collapse</span>
        </button>
      </div>
    </aside>
  );
}
