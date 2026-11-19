import { useCallback, useEffect, useState } from "react";
import type { Project } from "@ai-orchestrator/shared";
import {
  ApiError,
  fetchWorkflowShares,
  shareWorkflow,
  shareWorkflowWithUser,
  unshareWorkflow,
  unshareWorkflowWithUser,
  type WorkflowShareRecord,
  type WorkflowUserShareRecord
} from "../lib/api";

const ACCESS_LABEL = { read: "Can view", execute: "Can view and run" } as const;

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
  /** People it is shared with; undefined when the server did not list them (you cannot manage its shares). */
  const [userShares, setUserShares] = useState<WorkflowUserShareRecord[] | undefined>(undefined);
  const [personEmail, setPersonEmail] = useState("");
  const [personAccess, setPersonAccess] = useState<"read" | "execute">("read");
  const [notice, setNotice] = useState<string | null>(null);
  const [targetProjectId, setTargetProjectId] = useState<string>("");
  const [accessLevel, setAccessLevel] = useState<"read" | "execute">("read");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const response = await fetchWorkflowShares(workflowId);
      setShares(response.shares);
      setUserShares(response.userShares);
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

  const handleSharePerson = async () => {
    const email = personEmail.trim();
    if (!email) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const { share } = await shareWorkflowWithUser(workflowId, { email, accessLevel: personAccess });
      setPersonEmail("");
      if (share.accessLevel === "execute" && share.effectiveAccess === "read") {
        setNotice(`${share.email} is a ${share.role}, so they can view it but not run it.`);
      }
      await refresh();
    } catch (err) {
      setError(formatError(err));
    } finally {
      setBusy(false);
    }
  };

  const handleUnsharePerson = async (share: WorkflowUserShareRecord) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await unshareWorkflowWithUser(workflowId, share.userId);
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
    <div className="pg-modal-backdrop" role="presentation" onClick={onClose}>
      <div className="pg-modal settings-share-modal" role="dialog" aria-modal="true" aria-labelledby="share-modal-title" onClick={(event) => event.stopPropagation()}>
        <header className="pg-modal-header">
          <div>
            <h3 id="share-modal-title" className="pg-modal-title">Share "{workflowName}"</h3>
            <p className="settings-help">
              Let people or other projects view or run it. Nobody it is shared with can edit it, and it stays in{" "}
              <code>{owningProjectId}</code>.
            </p>
          </div>
          <button type="button" className="pg-btn ghost small" onClick={onClose} aria-label="Close share dialog">
            Close
          </button>
        </header>
        <div className="pg-modal-body">
          {error && (
            <div className="settings-error" role="alert">
              {error}
            </div>
          )}
          {notice && (
            <div className="info-banner" role="status">
              {notice}
            </div>
          )}

          {userShares !== undefined && (
            <div className="settings-card">
              <h4>People</h4>
              <p className="settings-muted">They see only their own runs of it. Add them to the project to show them every run.</p>
              <form
                className="share-person-row"
                onSubmit={(event) => {
                  event.preventDefault();
                  void handleSharePerson();
                }}
              >
                <label htmlFor="share-person-email">Email</label>
                <input
                  id="share-person-email"
                  type="email"
                  autoComplete="off"
                  placeholder="ana@example.com"
                  value={personEmail}
                  onChange={(event) => setPersonEmail(event.target.value)}
                />
                <label htmlFor="share-person-access">Access</label>
                <select id="share-person-access" value={personAccess} onChange={(event) => setPersonAccess(event.target.value as "read" | "execute")}>
                  <option value="read">{ACCESS_LABEL.read}</option>
                  <option value="execute">{ACCESS_LABEL.execute}</option>
                </select>
                <div className="settings-actions">
                  <button type="submit" className="pg-btn primary" disabled={busy || !personEmail.trim()}>
                    Share with person
                  </button>
                </div>
              </form>
              {userShares.length === 0 ? (
                <p className="settings-muted">Not shared with anyone yet.</p>
              ) : (
                <table className="settings-table">
                  <thead>
                    <tr>
                      <th>Person</th>
                      <th>Access</th>
                      <th>Shared by</th>
                      <th>
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {userShares.map((share) => (
                      <tr key={share.userId}>
                        <td>
                          {share.email ?? share.userId}
                          {share.role ? <span className="settings-chip">{share.role}</span> : null}
                          {share.disabled ? <span className="settings-chip">Disabled</span> : null}
                        </td>
                        <td>
                          {share.effectiveAccess ? ACCESS_LABEL[share.effectiveAccess] : "No access while disabled"}
                          {share.effectiveAccess === "read" && share.accessLevel === "execute" ? (
                            <span className="settings-muted" title="Their role cannot run workflows">
                              {" "}
                              (role cannot run)
                            </span>
                          ) : null}
                        </td>
                        <td>{share.sharedBy ?? "—"}</td>
                        <td>
                          <button
                            className="pg-btn small ghost danger"
                            onClick={() => void handleUnsharePerson(share)}
                            disabled={busy}
                            aria-label={`Stop sharing with ${share.email ?? share.userId}`}
                          >
                            Remove
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}

          <div className="settings-card">
            <h4>Projects</h4>
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
                    className="pg-btn primary"
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
                          className="pg-btn small ghost danger"
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
