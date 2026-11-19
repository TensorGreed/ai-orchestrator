/**
 * Home's first row for people who can build: the starter templates, each a small workflow that runs on built-in
 * sample data with no model, key or server. "Use" makes a new workflow from it and opens it, as the Templates page does.
 */
import { useEffect, useState } from "react";
import { fetchTemplates, useTemplate as createFromTemplate, type TemplateListItem } from "../lib/api";

/** How many starters the row shows; the rest are one click away in Templates. */
const SHOWN = 4;

/** The starters shown first: each runs with one click on Run and shows a result straight away. */
const FIRST = ["builtin-starter-csv-to-json", "builtin-starter-loop-collect", "builtin-starter-retry-fallback", "builtin-starter-approval"];

const rank = (id: string) => (FIRST.includes(id) ? FIRST.indexOf(id) : FIRST.length);

interface HomeStartersProps {
  /** The project open in the studio: the new workflow goes there. */
  projectId: string;
  /** Opens the workflow the starter made. */
  onWorkflowCreated: (workflowId: string) => void | Promise<void>;
  /** Opens Templates on the Starters category. */
  onBrowseStarters: () => void;
}

export function HomeStarters({ projectId, onWorkflowCreated, onBrowseStarters }: HomeStartersProps) {
  const [starters, setStarters] = useState<TemplateListItem[] | null>(null);
  const [usingId, setUsingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Every starter, as the Templates page lists them (so "All N starters" counts the same); the row shows ones that run without setup.
    fetchTemplates({ category: "Starters" })
      .then((result) => {
        if (!cancelled) setStarters([...result.templates].sort((a, b) => rank(a.id) - rank(b.id)));
      })
      .catch(() => {
        // Home works without the row; Templates still lists them.
        if (!cancelled) setStarters([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!starters || starters.length === 0) return null;

  const use = async (templateId: string) => {
    setUsingId(templateId);
    setError(null);
    try {
      const created = await createFromTemplate(templateId, { projectId });
      await onWorkflowCreated(created.workflowId);
    } catch (useError) {
      setError(useError instanceof Error ? useError.message : "Could not make a workflow from this starter");
    } finally {
      setUsingId(null);
    }
  };

  return (
    <section className="home-starters" aria-labelledby="home-starters-title" data-testid="home-starters">
      <div className="home-starters-head">
        <h3 id="home-starters-title" className="home-starters-title">
          Starters
        </h3>
        <span className="home-starters-sub">Run without setup: no model, key or server needed.</span>
        <button type="button" className="auth-link-btn home-starters-all" onClick={onBrowseStarters}>
          All {starters.length} starters
        </button>
      </div>
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      <div className="home-starters-row">
        {starters.filter((starter) => !starter.dependencies || starter.dependencies.length === 0).slice(0, SHOWN).map((starter) => (
          <article key={starter.id} className="home-starter-card" data-testid={`home-starter-${starter.id}`}>
            <h4 className="home-starter-name">{starter.name}</h4>
            <p className="home-starter-desc">{starter.description}</p>
            <button
              type="button"
              className="pg-btn small"
              disabled={usingId !== null}
              aria-label={`Use starter ${starter.name}`}
              onClick={() => void use(starter.id)}
            >
              {usingId === starter.id ? "Creating…" : "Use"}
            </button>
          </article>
        ))}
      </div>
    </section>
  );
}
