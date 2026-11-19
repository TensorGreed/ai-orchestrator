import { useCallback, useEffect, useState } from "react";
import {
  fetchTemplates,
  useTemplate,
  type TemplateListItem
} from "../lib/api";

const CATEGORIES = [
  "All",
  "Starters",
  "Getting Started",
  "RAG & AI",
  "Agents",
  "Logic & Control",
  "Cloud Integrations"
] as const;

interface TemplateGalleryProps {
  onWorkflowCreated: (workflowId: string) => void | Promise<void>;
  initialCategory?: string;
  /** The project open in the studio: a workflow made from a template goes there. */
  projectId?: string;
}

export function TemplateGallery({ onWorkflowCreated, initialCategory, projectId }: TemplateGalleryProps) {
  const [templates, setTemplates] = useState<TemplateListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<string>(
    initialCategory && (CATEGORIES as readonly string[]).includes(initialCategory) ? initialCategory : "All"
  );
  const [searchQuery, setSearchQuery] = useState("");
  // Only templates with nothing to set up (no model, key, server or service).
  const [withoutSetupOnly, setWithoutSetupOnly] = useState(false);
  const [usingTemplateId, setUsingTemplateId] = useState<string | null>(null);

  const loadTemplates = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const filters: { category?: string; search?: string; withoutSetupOnly?: boolean } = {};
      if (activeCategory !== "All") filters.category = activeCategory;
      if (searchQuery.trim()) filters.search = searchQuery.trim();
      if (withoutSetupOnly) filters.withoutSetupOnly = true;
      const result = await fetchTemplates(filters);
      setTemplates(result.templates);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load templates");
    } finally {
      setLoading(false);
    }
  }, [activeCategory, searchQuery, withoutSetupOnly]);

  useEffect(() => {
    void loadTemplates();
  }, [loadTemplates]);

  const handleUseTemplate = useCallback(
    async (templateId: string) => {
      setUsingTemplateId(templateId);
      try {
        const result = await useTemplate(templateId, { projectId });
        await onWorkflowCreated(result.workflowId);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to create workflow from template");
      } finally {
        setUsingTemplateId(null);
      }
    },
    [onWorkflowCreated, projectId]
  );

  return (
    <div className="tpl-gallery page-pane">
      <header className="page-head tpl-header">
        <div className="page-head-copy"><h2 className="page-title">Templates</h2><p className="page-sub">Start from a working workflow and make it yours.</p></div>
        <label className="page-search">
          <span className="page-search-icon" aria-hidden="true">
            ⌕
          </span>
          <input
            type="text"
            className="tpl-search"
            placeholder="Search templates…"
            aria-label="Search templates"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </label>
      </header>

      <div className="tpl-categories" role="group" aria-label="Template categories">
        {CATEGORIES.map((cat) => (
          <button
            key={cat}
            type="button"
            className={`tpl-category-btn${activeCategory === cat ? " active" : ""}`}
            aria-pressed={activeCategory === cat}
            onClick={() => setActiveCategory(cat)}
          >
            {cat}
          </button>
        ))}
        <span className="tpl-categories-sep" aria-hidden="true" />
        <button
          type="button"
          className={`tpl-category-btn tpl-filter-no-setup${withoutSetupOnly ? " active" : ""}`}
          aria-pressed={withoutSetupOnly}
          title="Only templates with no model, key, server or service to set up"
          onClick={() => setWithoutSetupOnly((current) => !current)}
        >
          Runs without setup
        </button>
      </div>

      {error && <div className="tpl-error">{error}</div>}

      {loading ? (
        <div className="tpl-loading">Loading templates...</div>
      ) : templates.length === 0 ? (
        <div className="tpl-empty">{withoutSetupOnly ? "No templates here run without setup." : "No templates found."}</div>
      ) : (
        <div className="tpl-grid">
          {templates.map((tpl) => (
            <div
              key={tpl.id}
              className={tpl.featured ? "tpl-card tpl-card-featured" : "tpl-card"}
              data-testid={`tpl-card-${tpl.id}`}
            >
              {tpl.thumbnailSvg ? (
                <div
                  className="tpl-card-thumbnail"
                  data-testid={`tpl-thumbnail-${tpl.id}`}
                  // SVG is generated server-side from a workflow we control —
                  // no XSS risk. dangerouslySetInnerHTML lets us embed inline
                  // SVG without round-tripping through a data URL.
                  dangerouslySetInnerHTML={{ __html: tpl.thumbnailSvg }}
                />
              ) : null}
              {tpl.featured && (
                <div className="tpl-card-featured-badge" data-testid={`tpl-featured-${tpl.id}`}>
                  ★ Featured
                </div>
              )}
              <div className="tpl-card-name">{tpl.name}</div>
              <div className="tpl-card-desc">
                {tpl.description || "No description provided."}
              </div>
              <div className="tpl-card-meta">
                <span className="tpl-badge">{tpl.category}</span>
                <span>{tpl.nodeCount} node{tpl.nodeCount !== 1 ? "s" : ""}</span>
                <span>by {tpl.author || "Unknown"}</span>
              </div>
              {tpl.tags.length > 0 && (
                <div className="tpl-card-tags">
                  {tpl.tags.map((tag) => (
                    <span key={tag} className="tpl-tag">
                      {tag}
                    </span>
                  ))}
                </div>
              )}
              {tpl.dependencies && tpl.dependencies.length === 0 ? (
                <div className="tpl-card-deps tpl-card-deps-none" data-testid={`tpl-deps-${tpl.id}`}>
                  <span className="tpl-dep-pill tpl-dep-pill-none">
                    Runs without setup
                  </span>
                </div>
              ) : tpl.dependencies && tpl.dependencies.length > 0 ? (
                <div className="tpl-card-deps" data-testid={`tpl-deps-${tpl.id}`}>
                  {tpl.dependencies.some((dep) => dep.kind === "provider") ? (
                    <span
                      className="tpl-dep-pill tpl-dep-pill-needs-model"
                      data-testid={`tpl-needs-model-${tpl.id}`}
                      title="Set a provider on the model node before running, or switch it to the built-in Echo model to try the flow."
                    >
                      Needs a model
                    </span>
                  ) : null}
                  <span className="tpl-deps-eyebrow">Requires</span>
                  {tpl.dependencies.map((dep) => (
                    <span
                      key={`${dep.kind}:${dep.label}`}
                      className={`tpl-dep-pill tpl-dep-pill-${dep.kind}`}
                      title={dep.envVar ? `Set ${dep.envVar} or wire a Secret` : undefined}
                    >
                      {dep.label}
                      {dep.envVar ? <span className="tpl-dep-envvar"> · {dep.envVar}</span> : null}
                    </span>
                  ))}
                </div>
              ) : null}
              <div className="tpl-card-actions">
                <button
                  type="button"
                  className="pg-btn primary small tpl-use-btn"
                  disabled={usingTemplateId === tpl.id}
                  onClick={() => void handleUseTemplate(tpl.id)}
                >
                  {usingTemplateId === tpl.id ? "Creating..." : "Use Template"}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
