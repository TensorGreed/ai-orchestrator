import { AppSidebar, type AppSidebarProps } from "./AppSidebar";

export type LeftMenuBarProps = AppSidebarProps;

/** Collapsible workspace sidebar. Kept under the legacy export name so App.tsx wiring stays unchanged. */
export function LeftMenuBar(props: LeftMenuBarProps) {
  return <AppSidebar {...props} />;
}
