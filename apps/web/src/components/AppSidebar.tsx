import { useCallback, useEffect, useRef, useState } from "react";
import type { Project } from "@ai-orchestrator/shared";
import { SHELL_DRAWER_MEDIA_QUERY, useMediaQuery } from "../lib/use-media-query";
import { CloseIcon, CollapseIcon, ExpandIcon, MenuIcon, MODE_ICONS, PlusIcon, ProductMark } from "./shell-icons";
import { STUDIO_MODE_ITEMS, type StudioMode } from "./studio-layout-types";

export const SIDEBAR_COLLAPSED_STORAGE_KEY = "l2m:sidebar-collapsed";

/** DOM id of the sidebar; the HUD menu button points at it with `aria-controls`. */
export const APP_SIDEBAR_ID = "app-sidebar";

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

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
  /**
   * Phone layout: whether the off-canvas drawer is open. App controls it so the HUD menu
   * button can open it; when omitted the sidebar keeps its own drawer state.
   */
  drawerOpen?: boolean;
  onDrawerOpenChange?: (open: boolean) => void;
}

export interface SidebarMenuButtonProps {
  open: boolean;
  onToggle: () => void;
}

/** HUD button that opens the sidebar drawer at phone widths (hidden by CSS on wider screens). */
export function SidebarMenuButton({ open, onToggle }: SidebarMenuButtonProps) {
  return (
    <button
      type="button"
      className="hud-pill hud-btn hud-icon-btn hud-menu-btn"
      onClick={onToggle}
      aria-label="Open navigation"
      aria-expanded={open}
      aria-controls={APP_SIDEBAR_ID}
      title="Open navigation"
    >
      <MenuIcon />
    </button>
  );
}

export function AppSidebar({
  activeMode,
  canManageSecrets,
  onModeChange,
  projects,
  activeProjectId,
  onChangeActiveProject,
  onCreateProject,
  onCollapsedChange,
  drawerOpen,
  onDrawerOpenChange
}: AppSidebarProps) {
  const [collapsed, setCollapsed] = useState<boolean>(readSidebarCollapsed);
  const isDrawer = useMediaQuery(SHELL_DRAWER_MEDIA_QUERY);
  const [ownDrawerOpen, setOwnDrawerOpen] = useState(false);
  const requestedOpen = drawerOpen ?? ownDrawerOpen;
  const open = isDrawer && requestedOpen;
  const asideRef = useRef<HTMLElement>(null);
  const lastModeRef = useRef(activeMode);

  useEffect(() => {
    writeSidebarCollapsed(collapsed);
    onCollapsedChange?.(collapsed);
  }, [collapsed, onCollapsedChange]);

  const toggleCollapsed = useCallback(() => setCollapsed((value) => !value), []);

  const setDrawerOpen = useCallback(
    (next: boolean) => {
      if (onDrawerOpenChange) onDrawerOpenChange(next);
      else setOwnDrawerOpen(next);
    },
    [onDrawerOpenChange]
  );

  // Focus moves into the drawer when it opens and back to whatever opened it (the HUD menu
  // button) when it closes.
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const aside = asideRef.current;
    const target =
      aside?.querySelector<HTMLElement>('.sidebar-item[aria-current="page"]') ??
      aside?.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
    target?.focus();
    return () => {
      if (previous && previous.isConnected) previous.focus();
    };
  }, [open]);

  // Escape closes the drawer. Listening in the capture phase and marking the event handled
  // keeps the editor inspector's own Escape handler from also closing it. Tab wraps inside
  // the drawer while it is open.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        setDrawerOpen(false);
        return;
      }
      if (event.key !== "Tab") return;
      const aside = asideRef.current;
      if (!aside) return;
      const focusables = Array.from(aside.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !aside.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !aside.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, setDrawerOpen]);

  // Navigating from anywhere (sidebar, command palette, account menu) closes the drawer, and
  // so does widening the window past the phone breakpoint.
  useEffect(() => {
    if (lastModeRef.current === activeMode) return;
    lastModeRef.current = activeMode;
    if (requestedOpen) setDrawerOpen(false);
  }, [activeMode, requestedOpen, setDrawerOpen]);

  useEffect(() => {
    if (!isDrawer && requestedOpen) setDrawerOpen(false);
  }, [isDrawer, requestedOpen, setDrawerOpen]);

  const items = STUDIO_MODE_ITEMS.filter((item) => !item.adminOnly || canManageSecrets);
  const activeProject = projects?.find((project) => project.id === activeProjectId);
  const showProjects = Boolean(projects && onChangeActiveProject);

  // The drawer always shows labels; the stored desktop collapsed preference is left alone.
  const showCollapsed = collapsed && !isDrawer;
  const hiddenDrawer = isDrawer && !open;
  const asideClassName = ["app-sidebar", showCollapsed && "is-collapsed", isDrawer && "is-drawer", open && "is-drawer-open"]
    .filter(Boolean)
    .join(" ");

  return (
    <>
      <aside
        ref={asideRef}
        id={APP_SIDEBAR_ID}
        className={asideClassName}
        aria-label="Studio navigation"
        data-collapsed={collapsed ? "true" : "false"}
        data-drawer={isDrawer ? (open ? "open" : "closed") : undefined}
        aria-hidden={hiddenDrawer ? true : undefined}
        inert={hiddenDrawer ? true : undefined}
      >
        <div className="sidebar-brand">
          <ProductMark compact={showCollapsed} />
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
                    onClick={() => {
                      onModeChange(item.mode);
                      if (isDrawer) setDrawerOpen(false);
                    }}
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
          {isDrawer ? (
            <button
              type="button"
              className="sidebar-item sidebar-toggle"
              onClick={() => setDrawerOpen(false)}
              aria-label="Close navigation"
              title="Close navigation"
            >
              <span className="sidebar-item-icon">
                <CloseIcon />
              </span>
              <span className="sidebar-item-label">Close</span>
            </button>
          ) : (
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
          )}
        </div>
      </aside>
      {open && <div className="app-sidebar-scrim" aria-hidden="true" onClick={() => setDrawerOpen(false)} />}
    </>
  );
}
