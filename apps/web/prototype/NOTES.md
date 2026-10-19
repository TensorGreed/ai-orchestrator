# PROTOTYPE — UI revamp directions (throwaway)

Question: what should L2M Studio look like so it stops reading as an n8n clone?

Open `prototype/ui-revamp.html` directly in a browser (no build). Bottom bar switches
between three directions and two real sample workflows.

- **A · Score** — the workflow as a readable document: numbered stages, parallel branches
  as side-by-side lanes, inline config (no modal), command bar instead of a nav rail.
- **B · Orbit** — agent-centric: the agent is a hub, model/memory/tools/workers are ring
  slots, the DAG is a stage strip along the bottom, config in a docked drawer. Dark-first.
- **C · Loom** — auto-laid-out columns by stage with threads between cards, attachments
  folded into the agent card as slot rows, persistent inspector and run tape.

Verdict (2026-10-19): **B · Orbit**, borrowing Loom's run tape, docked inspector, slot rows and
stage auto-layout. Implemented in `apps/web/src` on branch `ui/orbit`; see `apps/web/DESIGN.md`.

Delete this folder once the chosen direction is implemented in `apps/web/src`.
