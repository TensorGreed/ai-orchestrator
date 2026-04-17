import { useCallback, useEffect, useState } from "react";
import {
  fetchTemplates,
  useTemplate,
  type TemplateListItem
} from "../lib/api";

const CATEGORIES = [
  "All",
  "Getting Started",
  "RAG & AI",
  "Agents",
  "Logic & Control",
  "Cloud Integrations"
] as const;

interface TemplateGalleryProps {
  onWorkflowCreated: (workflowId: string) => void;
}

export function TemplateGallery({ onWorkflowCreated }: TemplateGalleryProps) {
  const [templates, setTemplates] = useState<TemplateListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<string>("All");
  const [searchQuery, setSearchQuery] = useState("");
  const [usingTemplateId, setUsingTemplateId] = useState<string | null>(null);

  const loadTemplates = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const filters: { category?: string; search?: string } = {};
      if (activeCategory !== "All") filters.category = activeCategory;
      if (searchQuery.trim()) filters.search = searchQuery.trim();
      const result = await fetchTemplates(filters);
      setTemplates(result.templates);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load templates");
    } finally {
      setLoading(false);
    }
  }, [activeCategory, searchQuery]);

  useEffect(() => {
    void loadTemplates();
  }, [loadTemplates]);

  const handleUseTemplate = useCallback(
    async (templateId: string) => {
      setUsingTemplateId(templateId);
      try {
        const result = await useTemplate(templateId);
        onWorkflowCreated(result.workflowId);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to create workflow from template");
      } finally {
        setUsingTemplateId(null);
      }
    },
    [onWorkflowCreated]
  );

  return (
    <div className="tpl-gallery">
      <div className="tpl-header">
        <h2 className="tpl-title">Template Gallery</h2>
        <input
          type="text"
          className="tpl-search"
          placeholder="Search templates..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>

      <div className="tpl-categories">
        {CATEGORIES.map((cat) => (
          <button
            key={cat}
            className={`tpl-category-btn${activeCategory === cat ? " active" : ""}`}
            onClick={() => setActiveCategory(cat)}
          >
            {cat}
          </button>
        ))}
      </div>

      {error && <div className="tpl-error">{error}</div>}

      {loading ? (
        <div className="tpl-loading">Loading templates...</div>
      ) : templates.length === 0 ? (
        <div className="tpl-empty">No templates found.</div>
      ) : (
        <div className="tpl-grid">
          {templates.map((tpl) => (
            <div key={tpl.id} className="tpl-card">
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
              <div className="tpl-card-actions">
                <button
                  className="tpl-use-btn"
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
