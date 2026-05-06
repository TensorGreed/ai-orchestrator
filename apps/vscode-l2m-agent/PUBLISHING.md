# Publishing the L2M Agent Extension

One-time setup + per-release steps for shipping `vscode-l2m-agent` to the **VS Code Marketplace** and **Open VSX Registry** (used by VSCodium, Cursor, Code-OSS, Theia).

This file is excluded from the packaged `.vsix` via `.vscodeignore`.

## Decisions to lock first

These need to be made before the first publication; they're hard to change later without renaming the extension.

### 1. Publisher account

The package.json currently sets `"publisher": "ai-orchestrator"`. **You probably want this to match your real publisher identity** — likely `tensorgreed` or a dedicated `l2m` publisher. The publisher is a global namespace on each marketplace and you have to register it once.

- VS Code Marketplace: <https://marketplace.visualstudio.com/manage/publishers>
- Open VSX: <https://open-vsx.org/user-settings/namespaces>

Edit `package.json` → `"publisher"` to your chosen ID before the first publish.

### 2. License

Currently `"license": "UNLICENSED"`. The marketplaces don't strictly require a license, but every reputable extension has one. For an OSS-positioned extension, **MIT** is the convention.

- Add `"license": "MIT"` to package.json
- Drop a `LICENSE` file in this folder (or symlink the repo-root LICENSE if it's MIT)
- vsce will warn if there's no LICENSE file — not fatal but visible.

### 3. Marketplace icon (PNG, 128×128 minimum)

`resources/l2m-agent.svg` exists for the in-app Activity Bar (VS Code accepts SVG there). The Marketplace listing requires a **PNG**, minimum 128×128, recommended 256×256. Steps:

```bash
# Pick one — both produce a 256×256 PNG from the SVG.
npx svgexport resources/l2m-agent.svg resources/l2m-agent.png 256:256
# or, if you have ImageMagick / Inkscape installed:
magick convert -background none -resize 256x256 resources/l2m-agent.svg resources/l2m-agent.png
```

Then add to package.json:

```jsonc
"icon": "resources/l2m-agent.png"
```

Re-run `pnpm --filter ./apps/vscode-l2m-agent run package` to bake the icon into the next .vsix.

### 4. README polish

The Marketplace listing renders the extension's `README.md` directly. Make sure it:

- Opens with a one-liner that matches the L2M positioning ("MCP-native agent runtime, in your editor").
- Has at least one screenshot or GIF of the chat sidebar in action. Marketplace cards with no visual lose to ones that have visuals.
- Lists the configuration settings + commands users will care about.
- Links back to the main docs site.

The current README is dev-oriented. Consider replacing it (or maintaining a separate `MARKETPLACE_README.md` and pointing `package.json` `"readme"` at it).

## Publish to VS Code Marketplace

### One-time

1. Sign in to <https://dev.azure.com> → create an **organization** if you don't have one.
2. **User settings → Personal Access Tokens** → New Token. Required scope: **Marketplace → Manage**. Copy the token (it's shown once).
3. Create the publisher at <https://marketplace.visualstudio.com/manage/publishers>. The ID must match `package.json` `"publisher"`.
4. Authenticate locally:

   ```bash
   pnpm --filter ./apps/vscode-l2m-agent exec vsce login <your-publisher-id>
   # paste the PAT when prompted
   ```

### Each release

```bash
# 1. Bump the version in apps/vscode-l2m-agent/package.json (semver).
# 2. Update apps/vscode-l2m-agent/CHANGELOG.md with the highlights.
# 3. Commit. Tag the commit with the new version (e.g. vscode-l2m-agent-v0.2.0).
# 4. Build + publish:
pnpm --filter ./apps/vscode-l2m-agent build
pnpm --filter ./apps/vscode-l2m-agent run publish:vsce
```

`publish:vsce` runs `vsce publish --no-dependencies`. The `--no-dependencies` flag skips npm dep walking (workspace deps would otherwise confuse vsce).

To publish a pre-release version use `--pre-release`:

```bash
pnpm --filter ./apps/vscode-l2m-agent exec vsce publish --no-dependencies --pre-release
```

## Publish to Open VSX (VSCodium / Cursor / Theia users)

Open VSX is the open-source mirror used by every VS Code fork that can't legally hit the Microsoft Marketplace. Publishing there roughly doubles your reachable user base.

### One-time

1. Sign in to <https://open-vsx.org> with a GitHub account.
2. **User settings → Access Tokens** → generate a token. Copy it.
3. Either set `OVSX_PAT` in your shell, or pass `--pat` on each publish.
4. Create the namespace at <https://open-vsx.org/user-settings/namespaces> — must match `package.json` `"publisher"`.

### Each release

After the VS Code Marketplace publish, push the same `.vsix` to Open VSX:

```bash
export OVSX_PAT=<your-token>
pnpm --filter ./apps/vscode-l2m-agent run publish:openvsx
```

`publish:openvsx` runs `ovsx publish vscode-l2m-agent.vsix`. Make sure you ran `pnpm run package` first so the `.vsix` exists.

## CI

The `vscode-extension` job in `.github/workflows/ci.yml` runs `build`, `test`, and `package` on every push, uploading the `.vsix` as a workflow artifact. To automate publishing on release tags, add a separate workflow that:

1. Triggers on tags matching `vscode-l2m-agent-v*`.
2. Downloads / regenerates the `.vsix`.
3. Calls `vsce publish` and `ovsx publish` with secrets stored in GitHub Actions: `VSCE_PAT` and `OVSX_PAT`.

A starter template for that release workflow:

```yaml
name: Publish VS Code Extension
on:
  push:
    tags:
      - "vscode-l2m-agent-v*"
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: "20", cache: "pnpm" }
      - run: corepack enable
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter ./apps/vscode-l2m-agent build
      - run: pnpm --filter ./apps/vscode-l2m-agent run package
      - run: pnpm --filter ./apps/vscode-l2m-agent exec vsce publish --no-dependencies --packagePath vscode-l2m-agent.vsix
        env:
          VSCE_PAT: ${{ secrets.VSCE_PAT }}
      - run: pnpm --filter ./apps/vscode-l2m-agent exec ovsx publish vscode-l2m-agent.vsix
        env:
          OVSX_PAT: ${{ secrets.OVSX_PAT }}
```

Don't add this until you've manually published once and confirmed both marketplaces accept the package.

## Verify before publishing

Before the first ever publish, manually install the `.vsix` produced by CI in a clean VS Code window and walk through:

1. Activity Bar shows the **L2M Agent** icon.
2. Sidebar chat opens, accepts a message, streams a response from your local L2M instance.
3. A patch action shows a preview, applies after approval, edits the right file with the right content.
4. A command action shows the command, runs in a terminal after approval, no auto-execute.
5. **L2M Agent: New Session** clears history and resets memory.

Every published version that fails any of those tests is a bad day. The VSCODE_L2M_AGENT_IMPLEMENTATION_PLAN.md "Hardening Pass" checklist covers the same ground.
