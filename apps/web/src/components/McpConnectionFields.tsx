/**
 * Transport-specific connection fields of the MCP server form. The connection
 * JSON string stays the single source of truth; these fields read it and write
 * it back, and the "Advanced: edit as JSON" textarea edits the same string.
 */

import { useEffect, useRef, useState } from "react";
import {
  connectionFromDraft,
  draftFromConnection,
  formatConnection,
  newRowId,
  parseCommandLine,
  parseConnectionJson,
  type StdioDraft
} from "./mcpConnection";

export function McpHttpFields({
  connectionJson,
  onConnectionJsonChange
}: {
  connectionJson: string;
  onConnectionJsonChange: (next: string) => void;
}) {
  const connection = parseConnectionJson(connectionJson);
  if (!connection) {
    return (
      <p className="kb-subtle" role="status">
        The connection JSON is not valid, so these fields are paused. Fix it under Advanced.
      </p>
    );
  }
  return (
    <div className="kb-form-row">
      <label>
        Endpoint URL
        <input
          type="text"
          inputMode="url"
          aria-required="true"
          value={typeof connection.endpoint === "string" ? connection.endpoint : ""}
          onChange={(event) => onConnectionJsonChange(formatConnection({ ...connection, endpoint: event.target.value }))}
          placeholder="https://example.com/mcp"
          spellCheck={false}
          aria-describedby="mcp-http-hint"
        />
      </label>
      <small id="mcp-http-hint" className="kb-subtle">
        Uses the HTTP Streamable transport, the only one this adapter supports. Credentials go in the Auth secret
        below.
      </small>
    </div>
  );
}

export function McpStdioFields({
  connectionJson,
  onConnectionJsonChange
}: {
  connectionJson: string;
  onConnectionJsonChange: (next: string) => void;
}) {
  const [draft, setDraft] = useState<StdioDraft>(() =>
    draftFromConnection(parseConnectionJson(connectionJson) ?? {})
  );
  const lastWritten = useRef(connectionJson);
  const [paste, setPaste] = useState("");
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const focusRow = useRef<string | null>(null);

  const connection = parseConnectionJson(connectionJson);
  const valid = connection !== null;

  // Re-read the rows when the JSON changed from outside these fields (the Advanced editor, a preset).
  useEffect(() => {
    if (connectionJson === lastWritten.current) return;
    lastWritten.current = connectionJson;
    const parsed = parseConnectionJson(connectionJson);
    if (parsed) setDraft(draftFromConnection(parsed));
  }, [connectionJson]);

  useEffect(() => {
    if (!focusRow.current) return;
    const el = document.querySelector<HTMLInputElement>(`[data-focus-key="${focusRow.current}"]`);
    focusRow.current = null;
    el?.focus();
  });

  if (!valid || !connection) {
    return (
      <p className="kb-subtle" role="status">
        The connection JSON is not valid, so these fields are paused. Fix it under Advanced.
      </p>
    );
  }

  const commit = (next: StdioDraft) => {
    setDraft(next);
    const json = formatConnection(connectionFromDraft(connection, next));
    lastWritten.current = json;
    onConnectionJsonChange(json);
  };

  const setArg = (index: number, value: string) =>
    commit({ ...draft, args: draft.args.map((row, i) => (i === index ? { ...row, value } : row)) });
  const addArg = () => {
    const row = { id: newRowId(), value: "" };
    focusRow.current = `arg-${row.id}`;
    commit({ ...draft, args: [...draft.args, row] });
  };
  const removeArg = (index: number) => {
    const total = draft.args.length - 1;
    const neighbour = draft.args[index + 1] ?? draft.args[index - 1];
    focusRow.current = neighbour ? `arg-${neighbour.id}` : "add-arg";
    commit({ ...draft, args: draft.args.filter((_, i) => i !== index) });
    setAnnounce(`Removed argument ${index + 1}. ${total} left.`);
  };
  const moveArg = (index: number, delta: -1 | 1) => {
    const target = index + delta;
    if (target < 0 || target >= draft.args.length) return;
    const args = [...draft.args];
    const [moved] = args.splice(index, 1);
    args.splice(target, 0, moved as (typeof args)[number]);
    focusRow.current = `arg-${moved?.id}`;
    commit({ ...draft, args });
    setAnnounce(`Moved argument to position ${target + 1} of ${args.length}.`);
  };

  const setEnv = (index: number, patch: { key?: string; value?: string }) =>
    commit({ ...draft, env: draft.env.map((row, i) => (i === index ? { ...row, ...patch } : row)) });
  const addEnv = () => {
    const row = { id: newRowId(), key: "", value: "" };
    focusRow.current = `env-key-${row.id}`;
    commit({ ...draft, env: [...draft.env, row] });
  };
  const removeEnv = (index: number) => {
    focusRow.current = "add-env";
    commit({ ...draft, env: draft.env.filter((_, i) => i !== index) });
    setAnnounce(`Removed variable ${index + 1}.`);
  };

  const applyPaste = () => {
    const result = parseCommandLine(paste);
    if (!result.ok) {
      setPasteError(result.error);
      return;
    }
    if (result.tokens.length === 0) {
      setPasteError("Paste a command line first.");
      return;
    }
    setPasteError(null);
    const [command, ...rest] = result.tokens;
    commit({ ...draft, command: command as string, args: rest.map((value) => ({ id: newRowId(), value })) });
    setPaste("");
    setAnnounce(`Filled the command and ${rest.length} argument${rest.length === 1 ? "" : "s"}.`);
  };

  return (
    <div className="mcp-stdio-fields">
      <div className="kb-form-row">
        <label>
          Command
          <input
            type="text"
            aria-required="true"
            value={draft.command}
            onChange={(event) => commit({ ...draft, command: event.target.value })}
            placeholder="npx"
            spellCheck={false}
          />
        </label>
      </div>

      <fieldset className="mcp-rows" aria-label="Arguments">
        <legend>Arguments</legend>
        <p className="kb-subtle">One argument per row. Spaces inside a row are kept as part of that argument.</p>
        {draft.args.length === 0 && <p className="kb-subtle">No arguments.</p>}
        <ol className="mcp-row-list">
          {draft.args.map((row, index) => (
            <li key={row.id} className="mcp-row">
              <input
                type="text"
                aria-label={`Argument ${index + 1}`}
                data-focus-key={`arg-${row.id}`}
                value={row.value}
                onChange={(event) => setArg(index, event.target.value)}
                spellCheck={false}
              />
              <button
                type="button"
                className="pg-btn ghost"
                aria-label={`Move argument ${index + 1} up`}
                data-focus-key={`move-${row.id}-up`}
                disabled={index === 0}
                onClick={() => moveArg(index, -1)}
              >
                <span aria-hidden="true">↑</span>
              </button>
              <button
                type="button"
                className="pg-btn ghost"
                aria-label={`Move argument ${index + 1} down`}
                data-focus-key={`move-${row.id}-down`}
                disabled={index === draft.args.length - 1}
                onClick={() => moveArg(index, 1)}
              >
                <span aria-hidden="true">↓</span>
              </button>
              <button type="button" className="pg-btn ghost" aria-label={`Remove argument ${index + 1}`} onClick={() => removeArg(index)}>
                Remove
              </button>
            </li>
          ))}
        </ol>
        <div>
          <button type="button" className="pg-btn ghost" data-focus-key="add-arg" onClick={addArg}>
            + Add argument
          </button>
        </div>
        <div className="mcp-paste">
          <label>
            Paste a command line
            <input
              type="text"
              value={paste}
              onChange={(event) => setPaste(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  applyPaste();
                }
              }}
              placeholder={`npx -y @modelcontextprotocol/server-filesystem "/home/me/my docs"`}
              spellCheck={false}
              aria-describedby="mcp-paste-hint"
              aria-invalid={pasteError ? true : undefined}
            />
          </label>
          <button type="button" className="pg-btn ghost" onClick={applyPaste}>
            Fill command and arguments
          </button>
        </div>
        <small id="mcp-paste-hint" className="kb-subtle">
          Quotes group words and a backslash escapes the next character, as in a shell. This replaces the command and
          all arguments above.
        </small>
        {pasteError && (
          <div className="settings-error" role="alert">
            {pasteError}
          </div>
        )}
      </fieldset>

      <div className="kb-form-row">
        <label>
          Working folder (optional)
          <input
            type="text"
            value={draft.cwd}
            onChange={(event) => commit({ ...draft, cwd: event.target.value })}
            placeholder="Defaults to the API's working folder"
            spellCheck={false}
          />
        </label>
      </div>

      <fieldset className="mcp-rows" aria-label="Environment">
        <legend>Environment</legend>
        <p className="kb-subtle">
          Plain-text variables for the process. Do not put tokens or passwords here: pick an Auth secret below and the
          server receives it as an environment variable (set its name with <code>secretEnvVar</code> under Advanced).
        </p>
        {draft.env.length === 0 && <p className="kb-subtle">No variables.</p>}
        <ul className="mcp-row-list">
          {draft.env.map((row, index) => (
            <li key={row.id} className="mcp-row mcp-row-env">
              <input
                type="text"
                aria-label={`Variable ${index + 1} name`}
                data-focus-key={`env-key-${row.id}`}
                value={row.key}
                onChange={(event) => setEnv(index, { key: event.target.value })}
                placeholder="NAME"
                spellCheck={false}
              />
              <input
                type="text"
                aria-label={`Variable ${index + 1} value`}
                value={row.value}
                onChange={(event) => setEnv(index, { value: event.target.value })}
                placeholder="value"
                spellCheck={false}
              />
              <button type="button" className="pg-btn ghost" aria-label={`Remove variable ${index + 1}`} onClick={() => removeEnv(index)}>
                Remove
              </button>
            </li>
          ))}
        </ul>
        <div>
          <button type="button" className="pg-btn ghost" data-focus-key="add-env" onClick={addEnv}>
            + Add variable
          </button>
        </div>
      </fieldset>

      <p className="kb-subtle mcp-host-note">
        The command runs on the machine running the L2M API, as the API&apos;s user. In Docker, it runs inside the API
        container: mount the server&apos;s folder or run it over HTTP.
      </p>
      <div className="mcp-sr-only" role="status" aria-live="polite">
        {announce}
      </div>
    </div>
  );
}
