---
# Copy to docs/learn/<track>/<slug>.md (track: mcp, agents, security, testing, operations). The slug
# must be listed in that track's `pages` in .vitepress/site/tracks.ts (the planned slugs already are).
# Never rename a published slug: GitHub Pages cannot redirect. The build fails without title,
# description and level.
title: "Question-shaped title, at most 54 characters"
description: "One or two sentences, at most 155 characters: what the reader will understand after reading. Unique across the site."
level: beginner # beginner | intermediate | advanced
# Optional:
# sidebarTitle: "Shorter title for the sidebar and track lists"
# demo: wf-mcp-agent-quickstart   # a workflow id the live demo has (apps/web/src/demo/fixtures/workflows.json)
# demoRecorded: true              # only if the demo has a recorded run for it (fixtures/runs.json)
# related: [agent-loop, tool-calling] # glossary slugs, shown as "Key terms" under the guide
# about: agent-loop               # the glossary term the guide is mainly about (JSON-LD)
---

# The same title as above

The answer first, in two or three sentences that could be quoted on their own. Link a glossary
term the first time it appears: <Term id="agent-loop">agent loop</Term>.

## Sections with plain headings

Short sentences, concrete examples, claims that match the code.

## Further reading

- [A docs page](/runtime/agent-loop)
- [A recipe](/recipes/zero-key-mcp-agent)
- [A primary source](https://modelcontextprotocol.io/specification/2025-06-18/server/tools) (site name)
