import { useEffect } from "react";

const WELCOME_DISMISSED_STORAGE_KEY = "l2m:welcome-dismissed";

/** Read the dismissed flag from localStorage. Used by App.tsx to decide initial visibility. */
export function isWelcomeDismissed(): boolean {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(WELCOME_DISMISSED_STORAGE_KEY) === "1";
  } catch {
    return true;
  }
}

/** Mark the welcome modal as dismissed. Called from App.tsx after the user closes it. */
export function markWelcomeDismissed(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(WELCOME_DISMISSED_STORAGE_KEY, "1");
  } catch {
    // ignore storage errors (private mode, quota, etc.)
  }
}

interface WelcomeModalProps {
  open: boolean;
  docsUrl: string;
  onTryTemplate: () => void;
  onBuildAgent: () => void;
  onDismiss: () => void;
}

/**
 * One-time welcome overlay shown to brand-new users on first login. Three CTAs
 * that map to the three highest-leverage first-run paths:
 *   1. Try a template — opens the Template Gallery.
 *   2. Build an MCP agent — opens the gallery filtered to the Agents category.
 *   3. Open the docs — opens the docs site in a new tab (no navigation away).
 *
 * Dismissal persists in localStorage under `l2m:welcome-dismissed`. Users who
 * want to see it again can clear that key (no in-app toggle yet — kept simple).
 */
export function WelcomeModal({
  open,
  docsUrl,
  onTryTemplate,
  onBuildAgent,
  onDismiss
}: WelcomeModalProps) {
  // Close on Escape for keyboard accessibility.
  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onDismiss();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onDismiss]);

  if (!open) return null;

  return (
    <div
      className="welcome-backdrop"
      role="presentation"
      onClick={(event) => {
        // Click outside the card dismisses.
        if (event.target === event.currentTarget) {
          onDismiss();
        }
      }}
    >
      <div
        className="welcome-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="welcome-title"
        aria-describedby="welcome-subtitle"
      >
        <div className="welcome-header">
          <div>
            <h2 id="welcome-title" className="welcome-title">
              Welcome to L<sup>2</sup>M
            </h2>
            <p id="welcome-subtitle" className="welcome-subtitle">
              The MCP-native agent runtime — visual workflows, multi-agent Swarm,
              and a VS Code surface. Pick a starting point.
            </p>
          </div>
          <button
            type="button"
            className="welcome-close"
            onClick={onDismiss}
            aria-label="Dismiss welcome"
            title="Dismiss"
          >
            ×
          </button>
        </div>

        <div className="welcome-actions">
          <button
            type="button"
            className="welcome-action"
            onClick={onTryTemplate}
            data-testid="welcome-try-template"
          >
            <span className="welcome-action-eyebrow">Get started</span>
            <span className="welcome-action-title">Try a template</span>
            <span className="welcome-action-body">
              Browse the Template Gallery. The Basic LLM Flow runs out of the box —
              no API keys needed.
            </span>
          </button>

          <button
            type="button"
            className="welcome-action"
            onClick={onBuildAgent}
            data-testid="welcome-build-agent"
          >
            <span className="welcome-action-eyebrow">Build something real</span>
            <span className="welcome-action-title">Build an MCP agent</span>
            <span className="welcome-action-body">
              Open the Agents category. Compose Supervisor → Worker hierarchies that
              call any community MCP server as a tool.
            </span>
          </button>

          <a
            className="welcome-action"
            href={docsUrl}
            target="_blank"
            rel="noreferrer"
            data-testid="welcome-open-docs"
          >
            <span className="welcome-action-eyebrow">Learn how it works</span>
            <span className="welcome-action-title">Open the docs</span>
            <span className="welcome-action-body">
              Read the Why L<sup>2</sup>M page, the agent loop, and the
              workflow-as-MCP-tool composition pattern.
            </span>
          </a>
        </div>

        <div className="welcome-footer">
          <button type="button" className="welcome-skip" onClick={onDismiss}>
            Skip for now
          </button>
        </div>
      </div>
    </div>
  );
}
