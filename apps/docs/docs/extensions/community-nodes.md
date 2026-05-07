# Community Nodes

The community-node SDK lets third-party developers ship `l2m-nodes-*` npm packages that extend a running L2M instance with new LLM providers, MCP transports, and connectors — without modifying L2M source. Admins install them by package name from the Studio Settings UI; the loader validates each package's manifest, runs the registration function, and the new adapters are immediately usable.

This is the answer to the long tail of generic-SaaS connectors. L2M's in-tree connector library focuses on the niche (MCP, agent topology, IDE composability); everything else is community-author territory.

## Authoring quick reference

A community package is a regular npm package with two extra requirements:

1. **Name it `l2m-nodes-<something>`.** The loader only picks up packages with this prefix.
2. **Add an `l2m` manifest field to `package.json`:**

   ```json
   {
     "name": "l2m-nodes-cohere",
     "version": "1.0.0",
     "type": "module",
     "main": "./dist/index.js",
     "l2m": {
       "kind": "community-node-package",
       "apiVersion": 1
     }
   }
   ```

3. **Default-export a `CommunityNodePackage`:**

   ```ts
   import type { CommunityNodePackage } from "@ai-orchestrator/community-sdk";
   import type { LLMProviderAdapter } from "@ai-orchestrator/provider-sdk";

   const cohereAdapter: LLMProviderAdapter = {
     definition: { id: "cohere", label: "Cohere", supportsToolCalling: true },
     async generate(input, ctx) {
       // … call Cohere's API, return the canonical LLMGenerateResponse
     }
   };

   const pkg: CommunityNodePackage = {
     apiVersion: 1,
     displayName: "Cohere LLM Provider",
     description: "Adds the Cohere chat model as a first-class L2M provider.",
     author: "Your Name",
     license: "MIT",
     register(api) {
       api.registerProvider(cohereAdapter);
     }
   };

   export default pkg;
   ```

The L2M SDK packages are listed under `devDependencies` (types only; the runtime contract is structural so no runtime import is required).

The fastest way to start is the **[l2m-nodes-template](https://github.com/TensorGreed/l2m-nodes-template)** scaffold repo — clone it, rename, fill in the adapter, and publish.

## What you can register

`RegistrationApi` (passed to your `register()` call) exposes three contribution points:

| Method | Adds | Built-in registry it joins |
|---|---|---|
| `registerProvider(adapter)` | LLM provider (chat / completion / embeddings) | `@ai-orchestrator/provider-sdk` `ProviderRegistry` |
| `registerMCPAdapter(adapter)` | MCP server transport (e.g. websocket, custom) | `@ai-orchestrator/mcp-sdk` `MCPRegistry` |
| `registerConnector(adapter)` | External-system connector (HTTP API, SaaS) | `@ai-orchestrator/connector-sdk` `ConnectorRegistry` |

Custom workflow node types are not yet contributable — that requires hooking the executor's dispatch tables, which is on the roadmap. For now, custom node types should be in-tree PRs to L2M itself.

## Enabling on a server

Community-node loading is **off by default**. Two env vars control it:

```
COMMUNITY_NODES_ENABLED=true
COMMUNITY_NODES_DIR=./data/plugins
COMMUNITY_NODES_ALLOWLIST=l2m-nodes-cohere,l2m-nodes-mistral,l2m-nodes-vendor-*
```

- **`COMMUNITY_NODES_ENABLED`** — required. Without this the Settings tab shows a "Disabled" notice and admin routes return 503.
- **`COMMUNITY_NODES_DIR`** — where `npm install` writes packages. Defaults to `./data/plugins`. The Helm chart's PVC mounts `apps/api/data/`, so packages survive pod restarts.
- **`COMMUNITY_NODES_ALLOWLIST`** — comma-separated list of permitted package names. Each entry is either an exact name (`l2m-nodes-cohere`) or a glob suffix (`l2m-nodes-corp-*`). Empty = allow any `l2m-nodes-*` package. Recommended for production: pin to specific allowed packages.

## Installing from the UI

1. Sign in as an admin.
2. **Settings → Community Nodes**.
3. Type the package spec (`l2m-nodes-cohere` or `l2m-nodes-cohere@1.2.3`), click **Install**.
4. The server runs `npm install --ignore-scripts <spec>`, validates the manifest, dynamic-imports the package, and calls `register()`.
5. Newly registered providers / MCP adapters / connectors show up in their respective node-config dropdowns immediately — no restart required.

## Hot-reload semantics

| Operation | Effect on running process |
|---|---|
| Install | New adapters added to live registries. Workflows that pick the new provider/MCP/connector use them on next execution. |
| Uninstall | Package files removed from disk. Adapters previously registered **stay loaded in memory** until the API restarts. |
| API version mismatch | Package marked `unsupported`; nothing registered. Other packages unaffected. |
| Registration error | Package marked `errored`; partial registrations stay (this is a future improvement — atomic register/rollback). |

The "uninstall doesn't unload" caveat is intentional: unloading dynamically-imported ES modules from a running V8 instance is fragile (and risks invalidating in-flight executions that hold adapter references). For a clean state, restart the API.

## Threat model

Running arbitrary npm packages in your API process is **not** a casual operation. Mitigations L2M provides:

- **Off by default.** Unset `COMMUNITY_NODES_ENABLED` in production unless you've explicitly chosen to allow community packages.
- **Admin-only.** Install/uninstall routes require the `admin` role. Other authenticated users can only see what's loaded.
- **Allowlist.** `COMMUNITY_NODES_ALLOWLIST` enforces an explicit list. A paranoid org should pin exact versions and review every entry.
- **`--ignore-scripts`.** L2M shells out to `npm install --ignore-scripts`, which refuses to execute the package's `preinstall`/`postinstall`/etc. — closing the most common npm supply-chain RCE vector.
- **Manifest validation.** A package without the right `l2m` field is refused; an `apiVersion` mismatch is refused.

What L2M does **not** do:

- **Sandbox the adapter at runtime.** Once loaded, a community adapter runs with the same privileges as built-in code: it can read secrets through `resolveSecret`, make outbound HTTP calls, write to the data directory, and call into other registered adapters.
- **Vet the package's source.** That's on you. Read the code before installing third-party packages, especially in production.
- **Kill a runaway adapter.** A community provider that throws inside `generate()` will surface as a workflow execution error, but a community adapter that hangs is L2M's hang.

For high-trust environments, run community-node-enabled L2M instances in a dedicated tenant (separate process, separate secrets, separate data) and only exchange artifacts through controlled APIs.

## Publishing your package

```bash
# Scaffold from the template
git clone https://github.com/TensorGreed/l2m-nodes-template l2m-nodes-myadapter
cd l2m-nodes-myadapter
# Rename in package.json, fill in the adapter, build
pnpm install
pnpm build
pnpm test
# Publish
npm publish
```

Once your package is on npm, anyone running an L2M instance with `COMMUNITY_NODES_ENABLED=true` (and an allowlist that includes your name) can install it from the Settings UI.

## Reference

- **API surface**: [`@ai-orchestrator/community-sdk`](https://github.com/TensorGreed/ai-orchestrator/tree/main/packages/community-sdk) — `CommunityNodePackage`, `RegistrationApi`, version constants.
- **Loader implementation**: [`apps/api/src/services/community-package-loader.ts`](https://github.com/TensorGreed/ai-orchestrator/blob/main/apps/api/src/services/community-package-loader.ts).
- **Admin routes**: `GET/POST/DELETE /api/community-nodes` — see app.ts for the full surface.
- **Template repo**: [`l2m-nodes-template`](https://github.com/TensorGreed/l2m-nodes-template) — clone, rename, customize, publish.
