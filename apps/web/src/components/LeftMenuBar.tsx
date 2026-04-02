import type { StudioMode } from "./studio-layout-types";

interface LeftMenuBarProps {
  activeMode: StudioMode;
  canManageSecrets: boolean;
  onModeChange: (mode: StudioMode) => void;
}

export function LeftMenuBar({ activeMode, canManageSecrets, onModeChange }: LeftMenuBarProps) {
  return (
    <aside className="app-rail">
      <button
        className="rail-btn"
        onClick={() => onModeChange("dashboard")}
        title="Dashboard"
        aria-pressed={activeMode === "dashboard"}
      >
        Home
      </button>
      <button
        className="rail-btn"
        onClick={() => onModeChange("editor")}
        title="Editor"
        aria-pressed={activeMode === "editor"}
      >
        Editor
      </button>
      <button
        className="rail-btn"
        onClick={() => onModeChange("variables")}
        title="Variables"
        aria-pressed={activeMode === "variables"}
      >
        Vars
      </button>
      <button
        className="rail-btn"
        onClick={() => onModeChange("executions")}
        title="Executions"
        aria-pressed={activeMode === "executions"}
      >
        Runs
      </button>
      <button
        className="rail-btn"
        onClick={() => onModeChange("chat")}
        title="Chat"
        aria-pressed={activeMode === "chat"}
      >
        Chat
      </button>
      <button
        className="rail-btn"
        onClick={() => onModeChange("evaluations")}
        title="Evaluations"
        aria-pressed={activeMode === "evaluations"}
      >
        Eval
      </button>
      {canManageSecrets && (
        <button
          className="rail-btn"
          onClick={() => onModeChange("secrets")}
          title="Secrets"
          aria-pressed={activeMode === "secrets"}
        >
          Secrets
        </button>
      )}
    </aside>
  );
}
