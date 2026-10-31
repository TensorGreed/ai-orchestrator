/**
 * Phase 12.2 — safety presets: ready-made tool rules over provenance labels. An admin adds one in a click; it is
 * created in shadow mode and enforced later from the rule list, with the usual checks. Builders see their state.
 */
import { useCallback, useEffect, useState } from "react";
import type { McpToolPolicyRule } from "@ai-orchestrator/shared";
import { addMcpSafetyPreset, fetchMcpSafetyPresets, type McpSafetyPresetState } from "../lib/api";

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : "Unexpected error";
}

export function McpSafetyPresets({ isAdmin, onAdded }: { isAdmin: boolean; onAdded: (rule: McpToolPolicyRule) => void }) {
  const [presets, setPresets] = useState<McpSafetyPresetState[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await fetchMcpSafetyPresets();
      setPresets(result.presets);
    } catch (err) {
      setError(formatError(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async (preset: McpSafetyPresetState) => {
    setBusy(preset.id);
    setError(null);
    try {
      const result = await addMcpSafetyPreset(preset.id);
      onAdded(result.rule);
      await load();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(null);
    }
  };

  if (!presets && !error) return null;

  return (
    <section className="kb-section" aria-label="Safety presets">
      <div className="mcp-section-head">
        <h4>Safety presets</h4>
      </div>
      <p className="kb-subtle">
        Ready-made rules for content from outside. A preset is added in shadow mode: it only records what it would have done,
        so check its hits before you enforce it from the rule list.
      </p>
      {error && <div className="settings-error">{error}</div>}
      <ul className="mcp-preset-list">
        {(presets ?? []).map((preset) => (
          <li key={preset.id} className="mcp-preset" data-testid={`mcp-preset-${preset.id}`}>
            <div>
              <strong>{preset.title}</strong>
              <p className="kb-subtle">{preset.summary}</p>
            </div>
            <div className="mcp-preset-state">
              {preset.added ? (
                <span className="mcp-class is-read">
                  Added
                  <span className="mcp-class-source">
                    {preset.enabled === false ? "disabled" : preset.mode === "enforce" ? "enforced" : "shadow"}
                    {preset.customised ? ", changed" : ""}
                  </span>
                </span>
              ) : isAdmin ? (
                <button type="button" className="pg-btn" disabled={busy !== null} onClick={() => void add(preset)}>
                  {busy === preset.id ? "Adding…" : "Add in shadow"}
                </button>
              ) : (
                <span className="kb-subtle">Not added</span>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
