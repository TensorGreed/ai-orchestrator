# Importing a workflow from another builder

L2M can import a workflow exported from another visual workflow builder. The export format it understands has top-level `nodes[]`, `connections{}`, `settings` and `pinData`. The import converts every node it can into an L2M node, rebuilds the edges, carries positions and sticky notes over, and hands back a report that tells you exactly what needs a human look before the flow runs.

The converter is pure: it never contacts the source system and never reads credential values. What you get is an ordinary L2M workflow (`schemaVersion 1.0.0`) that passes graph validation, plus the report.

## In the Studio

1. Open the import dialog from any of these places:
   - **Import…** on the Home page.
   - **Import from another builder…** in the editor's **⋯** menu.
   - The command palette (`⌘K` or `Ctrl+K`).
   - Dropping the `.json` export straight onto the canvas.
2. Drop the file, choose it, or paste the JSON. The Studio converts it with a dry run and shows a preview: how many nodes mapped, were approximated or became placeholders, the reason for each, and what you will need to fix afterwards. Nothing is saved yet.
3. Adjust the workflow name if you like and press **Import workflow**. The workflow is stored in the active project and opens in the editor.
4. A checklist docks on the canvas. It lists the credentials to link, variables to fill in, expressions to rewrite and placeholder nodes to replace. Items tick themselves off as you fix them. Clicking a node name selects it on the canvas.
   - **Link credentials**: pick a stored secret from the list. Every node that used that credential is pointed at it.
   - **Tidy layout** re-flows the imported graph into stages.
   - **Validate** saves pending edits and runs graph validation, listing any issues with links to the nodes involved.

The checklist stays with the workflow in your browser until you dismiss it, so you can leave for the Secrets or Variables page and come back. The Import JSON entry also recognises these exports and routes them through the same preview, while L2M's own exports import directly.

## Endpoint

```
POST /api/workflows/import/external
```

Requires the **builder** role or above, and `workflow:write` in the target project.

| Field | Type | Meaning |
|---|---|---|
| `source` | object | The export JSON as an object. |
| `sourceText` | string | The export JSON as a string (for drag-and-drop uploads). Used when `source` is absent. |
| `projectId` | string | Target project. Defaults to the folder's project, else `default`. |
| `folderId` | string | Target folder. Must exist and belong to the target project. |
| `name` | string | Overrides the workflow name from the export. |
| `dryRun` | boolean | When `true`, converts and validates but stores nothing. |

The response is `{ workflow, report }`. With `dryRun: true` the workflow is the converted document and nothing is written; otherwise it is the stored workflow (with its final id, project and folder) and the import is recorded in the audit log as `workflow.import_external`.

A malformed export returns `400` with a message naming what is missing, for example a top-level `nodes` array or a node without a `type`.

```bash
curl -X POST http://localhost:4000/api/workflows/import/external \
  -H "content-type: application/json" \
  --cookie "ao_session=..." \
  -d '{ "sourceText": "<contents of the export file>", "dryRun": true }'
```

Run it once with `dryRun: true`, read the report, then run it again without the flag when you are happy with the mapping.

## The three node statuses

Every source node appears exactly once in `report.nodes` with one of three statuses and a reason:

| Status | Meaning |
|---|---|
| `mapped` | The node has a direct L2M equivalent and its settings were carried over. |
| `approximated` | The node was converted, but something was simplified. The reason says what, for example "only the first sort field was imported". |
| `unsupported` | There is no L2M equivalent yet. The node becomes a placeholder (see below). |

`report.summary` holds the counts, and `report.warnings` lists workflow-level issues such as dropped connections or an invalid timezone.

## Placeholders for unsupported nodes

An unsupported node is imported as a **disabled** `noop_node` named after the original node, labelled `Unsupported: <short type>`, the last segment of the source type. Its config keeps the original parameters under `importedFrom` (parameters, type, version, notes, and the *names* of any credentials) so nothing is lost when you replace it by hand.

Because the placeholder is a pass-through, the edges into and out of it are kept and the rest of the flow still loads, validates and runs. Attachments that cannot be honoured, for example a tool sub-node with no L2M equivalent, are dropped and listed in `report.warnings`.

## Expression translation

The common expression subset is translated into L2M template syntax. Translated references resolve against `results`, which exposes the output of every completed node by id.

```text
{{ $json.x }}  or  {{ $input.item.json.x }}        ->  {{results.<previous node id>.x}}
{{ $('Name').item.json.x }}  or  {{ $node["Name"].json.x }}
                                                   ->  {{results.<id of Name>.x}}
{{ $env.KEY }}  or  {{ $vars.KEY }}                ->  {{vars.KEY}}  (plus an empty workflow variable KEY to fill in)
{{ $now }}  or  {{ $now.toISO() }}                 ->  {{ $now.toISOString() }}
{{ $workflow.name }}  /  {{ $execution.id }}       ->  {{workflow.name}}  /  {{execution.id}}
```

IF, Switch and Filter conditions are compiled into L2M expressions; IF outputs become the `true` and `false` handles, Switch outputs become case handles with the extra fallback output on `default`.

JavaScript code nodes are wrapped in a small compatibility shim that provides `$json`, `$input`, `$('Name')` and item-list return values, so most code runs unchanged. Python code is kept verbatim and marked `approximated`.

Anything the translator does not understand is left **verbatim** and listed in `report.unresolvedExpressions` with the node id, the config path, the original expression and the reason, for example an unknown node name or a date helper with no equivalent. Those templates will render empty until you rewrite them, so treat the list as a checklist.

## Secrets checklist

Credential references in the export become `secretRef` placeholders. The import never stores or echoes a credential value: `report.secretsToResolve` lists each placeholder's `secretId`, the credential type, the credential *name* from the export, and the node ids that use it.

After importing:

1. Create the secret under **Secrets** if it does not exist yet, then link it from the import checklist in the editor. Through the API, replace the placeholder `secretId` in each listed node's config with the stored secret's id.
2. Fill in connection details that lived inside the source credential rather than the node, such as an IMAP host or an Azure OpenAI endpoint. The node's report reason says when this applies.
3. Set the workflow variables listed in `report.variablesToSet`.

## Coverage

The table below is generated from the converter's registration table. Regenerate it after changing the converter:

```bash
pnpm --filter @ai-orchestrator/workflow-engine gen:import-coverage
```

<!--@include: ./external-import-coverage.md-->
