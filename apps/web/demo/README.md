# L2M static live demo

The demo at **https://lsquarem.com/demo/** is the real `apps/web` studio built with
`vite build --mode demo`. In that mode the API client's transport (`src/lib/transport.ts`)
resolves to an in-browser fake backend (`src/demo/`), which answers from recorded fixtures.
There is no server, no sign-up and no network traffic beyond the page's own static files:
no model, no analytics, no remote fonts.

Normal builds never reference `src/demo/`: the swap is done by the `demoMode` plugin in
`vite.config.ts`, which only runs with `--mode demo` (checked by `src/demo/build-isolation.test.ts`).

## Commands (from the repo root)

| What | Command |
| --- | --- |
| Build the demo into `apps/web/dist-demo/` | `pnpm --filter @ai-orchestrator/web build:demo` |
| Serve it at http://localhost:4319/demo/ | `pnpm --filter @ai-orchestrator/web preview:demo` |
| Golden journey (Playwright) | `pnpm --filter @ai-orchestrator/web e2e:demo` |
| Re-record the fixtures | `pnpm --filter @ai-orchestrator/web demo:record` |

GitHub Pages publishes it from `.github/workflows/pages.yml` next to the marketing landing (`/`) and
the docs (`/docs/`); `scripts/assemble-pages-site.mjs` puts the three together. A failed demo build
does not block the site: it deploys without `/demo/` and the run shows a warning. Pages must use
**GitHub Actions** as its source.

## What the demo does

- Signs in as a fixed demo user (`demo@example.com`, admin) so the editor and every governance page
  are visible.
- **Workflows** are real state: list, open, create, edit, save, duplicate, delete, import and export
  JSON, and "Use template". They live in memory and in `localStorage` (`l2m-demo:state:v1`); with
  storage blocked the demo still works for the page's lifetime. **Reset demo** in the banner restores
  the fixtures.
- **Runs** replay the recorded event stream (node activity, run tape, tool calls, tokens, cost,
  guard verdicts) at a readable pace, but only for the recorded run's own input and graph:
  - the run input (the `user_prompt` of an editor, chat or webhook run) must equal the recorded one
    after trimming and collapsing whitespace, and so must the `system_prompt` (the studio's default
    one, which the recorder sends as the studio does);
  - the workflow's graph (node types, configs and edges; not layout or names) must be the one that
    was recorded. A copy with the same graph replays too;
  - partial and debug runs (`startNodeId`, `runMode: "single_node"`, `sourceExecutionId`) are never
    replayed.

  Another input gets "Runs need a real deployment" with **Try the recorded question**: in Chat on
  that workflow it puts the recorded question in the message box for the visitor to send; in the
  editor on that workflow, which has no prompt field, it runs the recorded question once (it shows
  as the trigger's input). With another workflow open it opens that workflow and runs it there.
  The request is for the very next run only: any run clears it, and it holds only for the same
  workflow on the same graph within two seconds. Another graph gets the same answer with a link that
  opens and runs the most similar recorded workflow, or a button to restore the recorded version.
  The demo never answers a question it has no recording for.
- **Recorded writes** (the replay diff of the gated workflow's draft against a golden run, the
  blocked publish of its v4) are kept with the request and the graph they were made against, and
  answer only that request on that graph; anything else gets the typed refusal.
- **Governance pages** show recorded data: Runs, Security (guard verdicts, data destinations),
  Approvals (approve and reject work on demo data and persist; the demo says that on a real
  deployment the paused run would now resume), Evaluations (golden sets, replay jobs, release
  gates), the release gate and golden-run replay diff on "FAQ answerer (release gated)", and the
  MCP pages.
- Links that point straight at the API (audit, cassette and guard-profile exports) show "Not
  available in the demo" instead of the static host's 404.
- Recorded timestamps are moved forward to the visit, so approvals are not expired and the
  last-14-days views have data.

## What it does not do

Sign-in, logout, registration, secrets, API keys, users and roles, provider and connector tests,
MCP connections and OAuth, sharing and Git sync answer **"Not available in the demo"** (HTTP 403,
`code: "not_in_demo"`). Any other request the fixtures have no answer for gets the same typed
error with HTTP 501, which the studio shows as a normal error message. Nothing is executed:
no model is called, no MCP server is reached, no code runs.

## The fixtures

`src/demo/fixtures/*.json` (about 1.5 MB) are recorded, not written by hand.
`demo/record-fixtures.mts` boots the real API in-process against a temporary SQLite database and:

1. seeds the sample workflows that run without cloud accounts, their templates, a guard profile,
   an MCP server registration (the in-process mock MCP adapter) and three data destinations;
2. runs, over the real streaming endpoint, the basic flow and MCP quickstart (built-in echo
   provider), an MCP agent with tools and memory, a supervisor with two workers, a guard block and
   three approval pauses (started by a second user so the demo user may decide them), with a scripted
   OpenAI-style model on 127.0.0.1 and the mock MCP adapter, so no key is needed;
3. saves a golden run of the support agent;
4. publishes v1 of a gated workflow, builds a golden set of three runs, saves a regressing draft,
   runs a real replay job against it, records the blocked publish and the draft's replay diff
   against a golden run, each with the request and graph it answered;
5. reads back every API answer the studio needs and writes them with the run streams.

Before writing, it replaces the scripted model's address with `models.example.com`, removes temp
paths and anything shaped like a credential, and refuses to write if anything is still found: the
patterns in `src/demo/leak-patterns.ts` (API keys, GitHub, Slack and AWS keys, JWTs, PEM blocks,
bearer tokens, `/home/<name>/`, `/Users/<name>/` and `C:\Users\` paths) and this machine's values:
home directory, repository path, the recording's master key and session cookie, and the user and
host names at any length as whole JSON-string tokens (`"vm"`, `/vm/`). Host and user names are
first replaced by `demo-host` / `demo-user` everywhere except the node definitions, which are
compiled from source (their placeholders, such as a database user `root`, are product defaults). `src/demo/fixtures.test.ts` checks the committed fixtures against the same
patterns, validates them against the `@ai-orchestrator/shared` schemas, and checks the size budget
and that only `example.com` / `example.org` addresses appear.

Re-record after API or UI changes that alter what the studio reads, then run
`pnpm --filter @ai-orchestrator/web test` and the demo journey. A new recording resets visitors'
saved demo state, since that state is keyed to `meta.recordedAt`.

When a page shows "Not available in the demo" for something that should work, the request is
missing from the recorder's list in `record-fixtures.mts`: add it there and record again.
