/**
 * 12.6 — the builder's warning next to a node's model: an admin limited which
 * models the deployment or the project may call, and this one is not on the
 * list. A warning only: the node saves, its runs fail at this node.
 */

import { useEffect, useState } from "react";
import { effectiveModelName, type LLMProviderConfig } from "@ai-orchestrator/shared";
import { checkModelAllowlist } from "../lib/api";

const CHECK_DELAY_MS = 300;

/** The refusal message for this provider config in `projectId`, or null (allowed, unknown yet, or not checkable). */
export function useModelAllowlistWarning(provider: Pick<LLMProviderConfig, "providerId" | "model" | "extra"> | null, projectId: string | null | undefined): string | null {
  const providerId = provider?.providerId?.trim() ?? "";
  const model = provider ? effectiveModelName(provider) : "";
  const [warning, setWarning] = useState<{ key: string; message: string | null } | null>(null);
  const key = JSON.stringify([providerId, model, projectId ?? null]);
  // A model chosen by an expression is only known at run time.
  const checkable = Boolean(providerId && model && !model.includes("{{") && !providerId.includes("{{"));

  useEffect(() => {
    if (!checkable) return undefined;
    let cancelled = false;
    const timer = setTimeout(() => {
      checkModelAllowlist({ providerId, model, projectId: projectId ?? null })
        .then((decision) => {
          if (!cancelled) setWarning({ key, message: decision.allowed ? null : decision.message });
        })
        .catch(() => {
          // No answer is no warning: the run itself still checks.
          if (!cancelled) setWarning({ key, message: null });
        });
    }, CHECK_DELAY_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [checkable, key, model, projectId, providerId]);

  return checkable && warning?.key === key ? warning.message : null;
}

export function ModelAllowlistWarning({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div className="warn-banner" role="status" data-testid="model-allowlist-warning">
      <strong>Model not allowed.</strong> {message} Runs fail at this node until an allowed model is picked or an admin
      adds it under Security → Models.
    </div>
  );
}
