/**
 * Transport-specific connection fields of the MCP server form. The connection
 * JSON string stays the single source of truth; these fields read it and write
 * it back, and the "Advanced: edit as JSON" textarea edits the same string.
 */

import { useEffect, useRef, useState } from "react";
import {
  connectionFromDraft,
  draftFromConnection,
  duplicateEnvNames,
  formatConnection,
  hasUneditableValues,
  newRowId,
  parseCommandLine,
  parseConnectionJson,
  type StdioDraft
} from "./mcpConnection";

export function McpHttpFields({
  connectionJson,
  onConnectionJsonChange,
  error
}: {
  connectionJson: string;
  onConnectionJsonChange: (next: string) => void;
  /** Submit-time problem with the endpoint, shown next to the field. */
  error?: string | null;
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
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "mcp-http-error mcp-http-hint" : "mcp-http-hint"}
        />
      </label>
      {error && (
        <small id="mcp-http-error" className="mcp-field-error">
          {error}
        </small>
      )}
      <small id="mcp-http-hint" className="kb-subtle">
        Uses the HTTP Streamable transport, the only one this adapter supports. Credentials go in the Auth secret
        below.
      </small>
    </div>
  );
}

export function McpStdioFields({
  connectionJson,
  onConnectionJsonChange,
  commandError,
  secretSelected = false
}: {
  connectionJson: string;
  onConnectionJsonChange: (next: string) => void;
  /** Submit-time problem with the command, shown next to the field. */
  commandError?: string | null;
  /** An Auth secret is chosen, so the variable name the server receives it under can be set. */
  secretSelected?: boolean;
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

  // Values the rows cannot hold without changing them (numbers, objects): shown read-only, JSON stays authoritative.
  const locked = hasUneditableValues(connection);
  const dupes = duplicateEnvNames(draft.env);

  const commit = (next: StdioDraft) => {
    setDraft(next);
    const json = formatConnection(connectionFromDraft(connection, next, { keepArgsAndEnv: locked }));
    lastWritten.current = json;
    onConnectionJsonChange(json);
  };

  const setSecretEnvVar = (value: string) => {
    const next = { ...connection };
    if (value) next.secretEnvVar = value;
    else delete next.secretEnvVar;
    const json = formatConnection(next);
    lastWritten.current = json;
    onConnectionJsonChange(json);
  };

  const setArg = (index: number, value: string) =>
    commit({ ...draft, args: draft.args.map((row, i) => (i === index ? { ...row, value } : row)) });
  const addArg = () => {
    const row = { id: newRowId(), value: "", allowEmpty: false };
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
    const neighbour = draft.env[index + 1] ?? draft.env[index - 1];
    focusRow.current = neighbour ? `env-key-${neighbour.id}` : "add-env";
    commit({ ...draft, env: draft.env.filter((_, i) => i !== index) });
    setAnnounce(`Removed variable ${index + 1}. ${draft.env.length - 1} left.`);
  };
  const setAllowEmpty = (index: number, allowEmpty: boolean) =>
    commit({ ...draft, args: draft.args.map((row, i) => (i === index ? { ...row, allowEmpty } : row)) });

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
    commit({ ...draft, command: command as string, args: rest.map((value) => ({ id: newRowId(), value, allowEmpty: true })) });
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
            aria-invalid={commandError ? true : undefined}
            aria-describedby={commandError ? "mcp-command-error mcp-command-hint" : "mcp-command-hint"}
            value={draft.command}
            onChange={(event) => commit({ ...draft, command: event.target.value })}
            placeholder="npx"
            spellCheck={false}
          />
        </label>
        {commandError && (
          <small id="mcp-command-error" className="mcp-field-error">
            {commandError}
          </small>
        )}
        <small id="mcp-command-hint" className="kb-subtle">
          The executable only, such as <code>npx</code>. Put its arguments in the rows below, or paste a whole command
          line there.
        </small>
      </div>

      <fieldset className="mcp-rows">
        <legend>Arguments</legend>
        {locked && (
          <p className="kb-subtle" role="status">
            This connection has values the form can&apos;t edit; use Advanced: edit as JSON.
          </p>
        )}
        {!locked && (
          <p className="kb-subtle">One argument per row. Spaces inside a row are kept as part of that argument.</p>
        )}
        {locked && (
          <ol className="mcp-row-list">
            {(Array.isArray(connection.args) ? connection.args : []).map((value, index) => (
              <li key={index} className="mcp-row mcp-row-readonly">
                <input type="text" readOnly aria-label={`Argument ${index + 1}`} value={JSON.stringify(value)} />
              </li>
            ))}
          </ol>
        )}
        {!locked && draft.args.length === 0 && <p className="kb-subtle">No arguments.</p>}
        <ol className="mcp-row-list" hidden={locked}>
          {(locked ? [] : draft.args).map((row, index) => (
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
              {row.value === "" && (
                <label className="mcp-check mcp-row-empty">
                  <input
                    type="checkbox"
                    checked={row.allowEmpty}
                    aria-label={`Argument ${index + 1} is an empty argument`}
                    onChange={(event) => setAllowEmpty(index, event.target.checked)}
                  />
                  Empty argument (<code>&quot;&quot;</code>)
                </label>
              )}
            </li>
          ))}
        </ol>
        {!locked && (
          <div>
            <button type="button" className="pg-btn ghost" data-focus-key="add-arg" onClick={addArg}>
              + Add argument
            </button>
          </div>
        )}
        {!locked && (
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
        )}
        {!locked && (
          <small id="mcp-paste-hint" className="kb-subtle">
            Quotes group words; <code>&quot;&quot;</code> is an empty argument. Outside quotes a backslash escapes only a
            quote, a backslash or a space, so <code>C:\Users\me\server.exe</code> works as typed. Variables are not
            expanded. This replaces the command and all arguments above.
          </small>
        )}
        {!locked && pasteError && (
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

      <fieldset className="mcp-rows">
        <legend>Environment</legend>
        <p className="kb-subtle">
          Plain-text variables for the process. Do not put tokens or passwords here: pick an Auth secret below and the
          server receives it as an environment variable. To pass several secrets, use a secret bundle and{" "}
          <code>secretEnvVars</code> under Advanced.
        </p>
        {locked && (
          <ul className="mcp-row-list">
            {Object.entries(
              connection.env && typeof connection.env === "object" && !Array.isArray(connection.env)
                ? (connection.env as Record<string, unknown>)
                : {}
            ).map(([key, value]) => (
              <li key={key} className="mcp-row mcp-row-env">
                <input type="text" readOnly aria-label={`Variable ${key} name`} value={key} />
                <input type="text" readOnly aria-label={`Variable ${key} value`} value={JSON.stringify(value)} />
              </li>
            ))}
          </ul>
        )}
        {!locked && draft.env.length === 0 && <p className="kb-subtle">No variables.</p>}
        <ul className="mcp-row-list" hidden={locked}>
          {(locked ? [] : draft.env).map((row, index) => (
            <li key={row.id} className="mcp-row mcp-row-env">
              <input
                type="text"
                aria-label={`Variable ${index + 1} name`}
                data-focus-key={`env-key-${row.id}`}
                value={row.key}
                onChange={(event) => setEnv(index, { key: event.target.value })}
                placeholder="NAME"
                spellCheck={false}
                aria-invalid={dupes.has(row.key.trim()) ? true : undefined}
                aria-describedby={dupes.has(row.key.trim()) ? `mcp-env-dupe-${row.id}` : undefined}
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
              {dupes.has(row.key.trim()) && (
                <small id={`mcp-env-dupe-${row.id}`} className="mcp-field-error mcp-row-note">
                  {row.key.trim()} is used more than once; only the last value is kept.
                </small>
              )}
            </li>
          ))}
        </ul>
        {!locked && (
          <div>
            <button type="button" className="pg-btn ghost" data-focus-key="add-env" onClick={addEnv}>
              + Add variable
            </button>
          </div>
        )}
      </fieldset>

      {secretSelected && (
        <div className="kb-form-row">
          <label>
            Environment variable for the secret (optional)
            <input
              type="text"
              value={typeof connection.secretEnvVar === "string" ? connection.secretEnvVar : ""}
              onChange={(event) => setSecretEnvVar(event.target.value)}
              placeholder="API_TOKEN"
              spellCheck={false}
              aria-describedby="mcp-secret-env-hint"
            />
          </label>
          <small id="mcp-secret-env-hint" className="kb-subtle">
            The server process receives the Auth secret under this name. Without a name the secret is not passed to the process (a secret bundle with secretEnvVars is the exception).
          </small>
        </div>
      )}

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
