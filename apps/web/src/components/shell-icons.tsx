import type { ReactElement, SVGProps } from "react";
import type { StudioMode } from "./studio-layout-types";

type IconProps = SVGProps<SVGSVGElement>;

function Svg({ children, ...rest }: IconProps) {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const HomeIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 11.5 12 4l9 7.5" />
    <path d="M5 10v10h14V10" />
  </Svg>
);

export const EditorIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="6" cy="6" r="2.5" />
    <circle cx="18" cy="12" r="2.5" />
    <circle cx="6" cy="18" r="2.5" />
    <path d="M8.3 7.2 15.7 11M8.3 16.8 15.7 13" />
  </Svg>
);

export const TemplatesIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="3" width="8" height="8" rx="2" />
    <rect x="13" y="3" width="8" height="8" rx="2" />
    <rect x="3" y="13" width="8" height="8" rx="2" />
    <path d="M17 14v6M14 17h6" />
  </Svg>
);

export const VariablesIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7 4c-2 0-3 1-3 3v3c0 1.2-.8 2-2 2 1.2 0 2 .8 2 2v3c0 2 1 3 3 3" />
    <path d="M17 4c2 0 3 1 3 3v3c0 1.2.8 2 2 2-1.2 0-2 .8-2 2v3c0 2-1 3-3 3" />
    <path d="M10 15l4-6M10 9l4 6" />
  </Svg>
);

export const RunsIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 12h4l2-5 4 10 2-5h6" />
  </Svg>
);

export const ChatIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 5h16v11H9l-5 4z" />
  </Svg>
);

export const EvaluationsIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
  </Svg>
);

export const KnowledgeIcon = (p: IconProps) => (
  <Svg {...p}>
    <ellipse cx="12" cy="6" rx="8" ry="3" />
    <path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6" />
    <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
  </Svg>
);

export const McpServersIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="7" rx="2" />
    <rect x="3" y="13" width="18" height="7" rx="2" />
    <path d="M7 7.5h.01M7 16.5h.01M11 7.5h6M11 16.5h6" />
  </Svg>
);

export const McpOverviewIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 17a8 8 0 1 1 16 0" />
    <path d="m12 17 4-5" />
    <path d="M4 20h16" />
  </Svg>
);

export const McpToolsIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14.5 5.5a4 4 0 0 0 4.9 4.9L21 12l-3 3-1.6-1.6a4 4 0 0 0-4.9-4.9" />
    <path d="M12.5 8.5 4 17a2.1 2.1 0 0 0 3 3l8.5-8.5" />
  </Svg>
);

export const McpPoliciesIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3 4 6v6c0 4.5 3.4 8.2 8 9 4.6-.8 8-4.5 8-9V6z" />
    <path d="m9 12 2 2 4-4" />
  </Svg>
);

export const McpToolsetsIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m12 3 9 5-9 5-9-5z" />
    <path d="m3 13 9 5 9-5" />
  </Svg>
);

export const McpClientsIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 3v4M15 3v4" />
    <path d="M6 7h12v4a6 6 0 0 1-12 0z" />
    <path d="M12 17v4" />
  </Svg>
);

export const McpPlaygroundIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3" />
    <path d="M7.5 14h9" />
  </Svg>
);

export const McpChangesIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3 12a9 9 0 1 0 3-6.7" />
    <path d="M3 4v4h4" />
    <path d="M12 8v4l3 2" />
  </Svg>
);

export const SecretsIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="14" r="4" />
    <path d="M11 11l9-9M16 6l2.5 2.5M13.5 8.5 16 11" />
  </Svg>
);

export const SecurityIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6l7-3z" />
    <path d="M9 12l2 2 4-4" />
  </Svg>
);

export const SettingsIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" />
  </Svg>
);

export const SunIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8" />
  </Svg>
);

export const MoonIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />
  </Svg>
);

export const HelpIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7" />
    <path d="M12 17h.01" />
  </Svg>
);

export const DocsIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 3h9l4 4v14H6z" />
    <path d="M15 3v4h4M9 12h6M9 16h6" />
  </Svg>
);

export const PlayIcon = (p: IconProps) => (
  <Svg {...p} fill="currentColor" stroke="none">
    <path d="M7 4.5v15l12-7.5z" />
  </Svg>
);

export const ChevronIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m9 6 6 6-6 6" />
  </Svg>
);

export const CollapseIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="3" />
    <path d="M9 4v16M15 10l-2 2 2 2" />
  </Svg>
);

export const ExpandIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="16" rx="3" />
    <path d="M9 4v16M13 10l2 2-2 2" />
  </Svg>
);

export const PlusIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

export const MenuIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Svg>
);

export const CloseIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
);

export const MoreIcon = (p: IconProps) => (
  <Svg {...p} fill="currentColor" stroke="none">
    <circle cx="5" cy="12" r="1.8" />
    <circle cx="12" cy="12" r="1.8" />
    <circle cx="19" cy="12" r="1.8" />
  </Svg>
);

export const SearchIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 5 5" />
  </Svg>
);

/** Phase 10.7 — My connections: a key joined to a link. */
export const ConnectionsIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="7.5" cy="12" r="3.5" />
    <path d="M11 12h10M17 12v3M20 12v2" />
  </Svg>
);

export const MODE_ICONS: Record<StudioMode, (p: IconProps) => ReactElement> = {
  dashboard: HomeIcon,
  editor: EditorIcon,
  templates: TemplatesIcon,
  variables: VariablesIcon,
  executions: RunsIcon,
  chat: ChatIcon,
  evaluations: EvaluationsIcon,
  knowledge: KnowledgeIcon,
  mcp: McpOverviewIcon,
  "mcp-servers": McpServersIcon,
  "mcp-tools": McpToolsIcon,
  "mcp-policies": McpPoliciesIcon,
  "mcp-toolsets": McpToolsetsIcon,
  "mcp-clients": McpClientsIcon,
  "mcp-playground": McpPlaygroundIcon,
  "mcp-changes": McpChangesIcon,
  connections: ConnectionsIcon,
  security: SecurityIcon,
  secrets: SecretsIcon,
  settings: SettingsIcon
};

/** Product mark: "L²M" set in the display face. */
export function ProductMark({ compact = false }: { compact?: boolean }) {
  return (
    <span className={compact ? "product-mark product-mark-compact" : "product-mark"} aria-label="L2M Studio">
      <span className="product-mark-glyph" aria-hidden="true">
        L<sup>2</sup>M
      </span>
      {!compact && <span className="product-mark-sub">Studio</span>}
    </span>
  );
}
