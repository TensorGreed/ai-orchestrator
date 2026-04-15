import { useCallback, useEffect, useState } from "react";
import type { Project } from "@ai-orchestrator/shared";
import {
  ApiError,
  fetchWorkflowShares,
  shareWorkflow,
  unshareWorkflow,
  type WorkflowShareRecord
} from "../lib/api";

interface WorkflowShareModalProps {
  workflowId: string;
  workflowName: string;
  owningProjectId: string;
  projects: Project[];
  onClose: () => void;
}

function formatError(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Unexpected error";
}

export function WorkflowShareModal({
  workflowId,
  workflowName,
  owningProjectId,
  projects,
  onClose
}: WorkflowShareModalProps) {
  const [shares, setShares] = useState<WorkflowShareRecord[]>([]);
  const [targetProjectId, setTargetProjectId] = useState<string>("");
  const [accessLevel, setAccessLevel] = useState<"read" | "execute">("read");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetchWorkflowShares(workflowId);
      setShares(response.shares);
    } catch (err) {
      setError(formatError(err));
    } finally {
      setLoaded(true);
    }
  }, [workflowId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const eligibleProjects = projects.filter(
    (project) => project.id !== owningProjectId && !shares.some((share) => share.projectId === project.id)
  );

  useEffect(() => {
    if (!targetProjectId && eligibleProjects.length > 0) {
      setTargetProjectId(eligibleProjects[0].id);
    }
  }, [targetProjectId, eligibleProjects]);

  const handleShare = async () => {
    if (!targetProjectId) return;
    setBusy(true);
    setError(null);
    try {
      await shareWorkflow(workflowId, { projectId: targetProjectId, accessLevel });
      setTargetProjectId("");
      await refresh();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleUnshare = async (projectId: string) => {
    setBusy(true);
    setError(null);
    try {
      await unshareWorkflow(workflowId, projectId);
      await refresh();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="node-modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="node-modal-shell settings-share-modal" onClick={(event) => event.stopPropagation()}>
        <header className="node-modal-header">
          <div>
            <h3>Share "{workflowName}"</h3>
            <p className="settings-help">
              Grant read or execute access to other projects. Shared workflows remain owned by{" "}
              <code>{owningProjectId}</code>.
            </p>
          </div>
          <button className="header-btn ghost" onClick={onClose}>
            Close
          </button>
        </header>
        <div className="node-modal-body">
          {error && <div className="settings-error">{error}</div>}

          <div className="settings-card">
            <h4>Add share</h4>
            {eligibleProjects.length === 0 ? (
              <p className="settings-muted">No other projects available to share with.</p>
            ) : (
              <>
                <label htmlFor="share-target">Target project</label>
                <select
                  id="share-target"
                  value={targetProjectId}
                  onChange={(event) => setTargetProjectId(event.target.value)}
                >
                  {eligibleProjects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
                <label htmlFor="share-access">Access level</label>
                <select
                  id="share-access"
                  value={accessLevel}
                  onChange={(event) => setAccessLevel(event.target.value as "read" | "execute")}
                >
                  <option value="read">Read</option>
                  <option value="execute">Execute</option>
                </select>
                <div className="settings-actions">
                  <button
                    className="header-btn"
                    onClick={handleShare}
                    disabled={busy || !targetProjectId}
                  >
                    Share
                  </button>
                </div>
              </>
            )}
          </div>

          <div className="settings-card">
            <h4>Current shares</h4>
            {!loaded ? (
              <div className="settings-loading">Loading…</div>
            ) : shares.length === 0 ? (
              <p className="settings-muted">Not shared with any other projects.</p>
            ) : (
              <table className="settings-table">
                <thead>
                  <tr>
                    <th>Project</th>
                    <th>Access</th>
                    <th>Shared by</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {shares.map((share) => (
                    <tr key={share.projectId}>
                      <td>
                        {projects.find((p) => p.id === share.projectId)?.name ?? share.projectId}
                      </td>
                      <td>{share.accessLevel}</td>
                      <td>{share.sharedBy ?? "—"}</td>
                      <td>
                        <button
                          className="mini-btn"
                          onClick={() => handleUnshare(share.projectId)}
                          disabled={busy}
                        >
                          Unshare
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
