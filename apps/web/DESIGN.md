# L2M Studio — "Orbit" UI direction

This is the design brief for the UI revamp. It is the single source of truth for every
surface in `apps/web`. The visual prototype that was chosen is
`apps/web/prototype/ui-revamp.html` (direction **B · Orbit**, borrowing the run tape,
persistent inspector, slot rows and auto-layout from **C · Loom**). Open it in a browser
when in doubt about how something should look.

## Why

L2M is an agent-native workflow runtime, but the old UI reads as an n8n clone: a left rail
of text buttons, a top bar, a free-drag grid canvas of rectangular nodes, agent attachments
dangling below as sub-nodes, and a three-pane Input | Parameters | Output modal. The
revamp keeps the same functionality while making the product's real difference, the agent
and its attachment ports, the visual identity. It must stay intuitive for first-time users.

## Identity

- **Dark-first, luminous.** Deep near-black ground with a soft radial glow, panels one step
  lighter, a cyan "glow" accent used sparingly for the thing that matters right now
  (selected, running, primary action). A complete light theme exists and gets the same care.
- **The agent is the center of gravity.** Agent Orchestrator / Supervisor nodes are round
  hubs. Their attachments sit on rings around the hub as slots, not as free nodes: chat
  model and memory on the inner ring, tools on the outer ring, workers as satellite hubs
  with their own mini-orbit. Empty required slots are visible as dashed "+" slots.
- **Stages, not a grid.** The DAG is auto-laid-out into stages (topological depth, ignoring
  attachment edges). A stage strip along the bottom of the editor shows the whole flow
  as a row of stage pills and focuses the canvas on click. Nodes remain draggable; "Tidy"
  re-applies the stage layout.
- **Config is docked, never modal.** Selecting a node opens a right-hand inspector drawer
  with Parameters / Input / Output / Trace tabs. The canvas stays visible.
- **The run is a tape.** The bottom panel shows per-node timing bars for the last run (LLM
  time in the tool/amber colour), plus the existing logs and chat tabs.
- **Type**: Inter throughout, with headings at 600–700 and tight tracking
  (`--ls-display`), JetBrains Mono for ids, types, keys and values. Decorative or
  display-only faces are out; the look must stay professional.

## Tokens

All colours, fonts, radii, shadows and layout widths live in `src/styles/tokens.css`.
Component CSS uses tokens only. **Never write a literal colour in component CSS.** That
rule is what fixes the broken dark theme (white cards on a dark page) for good.

Key tokens: `--bg`, `--bg-elev`, `--bg-elev-2`, `--bg-input`, `--line`, `--line-strong`,
`--fg`, `--fg-muted`, `--fg-faint`, `--accent`, `--accent-soft`, `--accent-line`,
`--port-model|memory|tool|worker` (+ `-soft`), `--agent`, `--agent-soft`, `--ok`,
`--warn`, `--err`, `--running`, `--font-display|body|mono`, `--r-sm|md|lg|pill`,
`--shadow-sm|md|lg`, `--glow-accent`, `--glow-agent`, `--sidebar-w`,
`--sidebar-w-collapsed`, `--sidebar-w-drawer`, `--hud-h`, `--inspector-w`, `--strip-h`, `--dur`, `--ease`.

Theme switching keeps the existing mechanism: `data-theme="dark" | "light"` on `<html>`.
Dark is the default (`:root`).

## CSS organisation

- `src/styles/tokens.css` — tokens (owned by the brief; extend only with new tokens).
- `src/styles/shell.css` — app shell: sidebar, HUD, command palette, login, banners.
- `src/styles/canvas.css` — editor canvas: cards, hubs, rings, edges, stage strip, tidy,
  node palette drawer, run tape.
- `src/styles/inspector.css` — node inspector drawer and its form controls.
- `src/styles/pages.css` — dashboard, templates, runs, chat, evaluations, knowledge bases,
  secrets, settings, variables, share modal, welcome.
- `src/styles.css` — legacy. Rules move out of here into the file above that owns them.
  Delete a legacy rule once the new rule replaces it; do not leave both.

## Shell

- **Sidebar (left, collapsible).** Product mark at top, project switcher, then the
  workspace sections with icon + label: Home, Editor, Templates, Variables, Runs, Chat,
  Evaluations, Knowledge, Secrets (admins), Settings. Collapses to an icon rail; the
  collapsed state is remembered per browser. Active item uses `--accent-soft` fill and an
  accent edge. Keyboard accessible, `aria-current="page"` on the active item.
- **Phone widths (≤ 880px).** The sidebar leaves the layout and becomes an off-canvas drawer
  (`--sidebar-w-drawer`) opened from a menu button at the start of the HUD. It closes on
  navigation, Escape and scrim click, takes focus while open and hands it back to the menu
  button. The desktop collapsed preference is not changed by the drawer. Secondary HUD pills
  (theme, shortcuts, docs, Refresh secrets, the editor's Save) hide; each stays reachable from
  the command palette, and the editor's Save also sits in the "⋯" overflow. The node inspector
  takes the full width.
- **HUD (top).** Not a solid bar: a row of floating pills on the glow background.
  Left: breadcrumb pill "Project / Workflow name" (name editable inline in the editor).
  Middle-left: run status pill (dot + "last run 42 s · 6 of 14 ok" or "running…").
  Right: ⌘K pill (opens the command palette), theme toggle, help, account menu, and the
  primary **Run ▸** button (editor only). Save / Export / Import / Share move into the
  command palette and a "⋯" overflow in the editor; Save also stays as a pill that shows
  the dirty state.
- **Command palette (⌘K / Ctrl+K).** Searchable list of: switch workflow, switch mode,
  add node (in the editor), run, save, export, import, toggle theme, open docs, shortcuts.

## Editor

- React Flow stays as the engine. Node positions remain in the workflow JSON.
- **Cards** (every non-agent node): rounded panel, glyph tile on the left, name on top,
  type in mono below, one-line config summary in mono (`summarizeNode(node)`), status
  ring (idle / running glow / ok / error), telemetry pills unchanged in meaning.
  Structural ports (if / switch / try-catch / intent router) keep labelled handles on the
  right edge.
- **Hubs** (`agent_orchestrator`, `supervisor_node`): circular, Syne title, type in mono,
  violet glow when selected or running. Attached nodes are placed automatically on rings
  relative to the hub and move with it; they are not freely draggable while attached.
  Attachment edges render as straight spokes in the port colour. Empty `chat_model` slot
  is dashed and labelled "+ model"; empty memory and tool slots are dashed "+". Clicking a
  slot opens the existing attachment drawer for that port.
- **Stage strip** (bottom): one pill per stage ("Stage 03 · 2 in parallel", first is
  "Trigger"), status colour from the run, click = fit view to that stage's nodes.
- **Tidy**: button in the canvas controls and in the palette; lays out stages left-to-right
  with hubs given extra room for their rings. Applied automatically on import when a
  workflow has no usable positions (all nodes at the same point).
- **Node palette**: the existing node drawer, restyled as a searchable palette grouped by
  category, opened from "+ Add" in the HUD, from ⌘K, or by double-clicking empty canvas.
- **Bottom panel**: tabs Run tape · Logs · Chat (whatever exists today), collapsible.

## Inspector (replaces NodeConfigModal)

- Docked on the right, `--inspector-w` wide, resizable, closes with Esc or the × button.
- Header: glyph, node name (editable), type · id in mono, "Run this node" button.
- Tabs: **Parameters** (all existing forms, unchanged in behaviour), **Input** (the
  existing input inspection), **Output** (existing output, pin / unpin), **Trace** (status,
  duration, tokens, latency, error + remediation for the last run).
- Footer: Cancel · Save changes (sticky). Unsaved edits show a dot on Save.
- Agent nodes get a **Slots** section at the top of Parameters listing model / memory /
  tools / workers with "+ attach" actions.

## Pages

Dashboard: a search box, folder filter, and workflow cards with name, id, tags, updated,
version, one primary "Open" action and a "⋯" menu (Chat, Execute, Tags, Folder, Duplicate,
Delete). No seven-button cards. Runs, Templates, Knowledge Bases, Secrets, Settings, Chat,
Evaluations, Variables: same functionality, restyled onto tokens with the new type.
Login: product mark, Syne title, one card on the glow background.

## Rules

- Both themes on every surface. Check each surface in light and dark before finishing.
- No literal colours in component CSS. Fonts only through `--font-display|body|mono`.
- Keep all existing behaviour and props; tests in `*.test.tsx` must pass and be updated
  for new markup. Add tests for new pure utilities (stage computation, orbit layout,
  node summaries).
- `prefers-reduced-motion` disables glow pulses and transitions.
- Focus-visible rings on every interactive element.
- No TODO comments. `pnpm --filter @ai-orchestrator/web exec tsc -b` and
  `pnpm --filter @ai-orchestrator/web test` must pass.
