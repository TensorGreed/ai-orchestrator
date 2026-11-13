// The Learn section's tracks: the order a reader goes through the guides in. One place drives the
// Learn sidebar, the track cards on /learn/, each track's index, each guide's header, its
// "next in this track" link and the TechArticle JSON-LD. Imports nothing from Node, so the theme
// can use it too.
//
// A guide lives at docs/learn/<track id>/<slug>.md and is listed below in reading order. The lists
// already hold the planned guides: a guide that is not written yet is skipped everywhere (no link,
// no card), so writing the file is all it takes to publish it in its place. A guide file that is
// in no list still builds, but the build warns. Published slugs are never renamed (GitHub Pages
// cannot redirect), so pick the slug once.

export type Level = "beginner" | "intermediate" | "advanced";

export const LEVEL_LABELS: Record<Level, string> = {
  beginner: "Beginner",
  intermediate: "Intermediate",
  advanced: "Advanced"
};

export interface Track {
  /** Folder under learn/ and the anchor on /learn/ (`#track-<id>`). */
  id: string;
  title: string;
  /** Short label for breadcrumbs and the sidebar. */
  shortTitle: string;
  /** One plain sentence for the track card. */
  summary: string;
  level: Level;
  /** Guide slugs in learn/<id>/, in reading order. */
  pages: string[];
  /** Where a reader goes after the last guide: another track's id, or a docs path (a guide in another track, or any page). */
  next: string;
}

export const TRACKS: Track[] = [
  {
    id: "mcp",
    title: "MCP fundamentals",
    shortTitle: "MCP fundamentals",
    summary: "What the Model Context Protocol is, how a tool call travels, which transport carries it, OAuth for remote servers and what tool annotations tell you.",
    level: "beginner",
    pages: ["what-is-mcp", "hosts-clients-servers", "tools-resources-prompts", "transports", "authorization", "tool-annotations"],
    next: "/learn/security/mcp-security-risks"
  },
  {
    id: "agents",
    title: "How AI agents work",
    shortTitle: "AI agents",
    summary: "The tool-calling loop, how agents stop and fail, supervisor and worker agents, what an agent remembers and where a person should approve.",
    level: "beginner",
    pages: ["what-is-an-ai-agent", "workflows-vs-agents", "supervisor-and-workers", "agent-memory", "too-many-tools", "human-in-the-loop"],
    next: "security"
  },
  {
    id: "security",
    title: "Agent security",
    shortTitle: "Agent security",
    summary: "Prompt injection, the OWASP Top 10 for LLM apps, the lethal trifecta, MCP security risks and least privilege for agents.",
    level: "intermediate",
    pages: ["prompt-injection", "owasp-llm-top-10", "lethal-trifecta", "mcp-security-risks", "least-privilege-for-agents", "sensitive-data-in-prompts"],
    next: "testing"
  },
  {
    id: "testing",
    title: "Testing and shipping agents",
    shortTitle: "Testing agents",
    summary: "Evals, regression tests built from recorded runs, testing MCP tool calls, and release gates that ship only what passed.",
    level: "intermediate",
    pages: ["agent-evals", "regression-testing-agents", "testing-mcp-tools", "release-gates", "from-production-to-tests", "observing-agents"],
    next: "operations"
  },
  {
    id: "operations",
    title: "Running AI in production",
    shortTitle: "Running in production",
    summary: "LLM gateways and MCP gateways, cost caps, self-hosting, audit trails, and identity: SSO, MFA, roles and keys.",
    level: "intermediate",
    pages: ["llm-gateway-vs-mcp-gateway", "llm-cost-control", "self-hosting-ai-agents", "ai-data-retention-and-erasure", "audit-trails-for-agents", "identity-for-ai-platforms"],
    next: "/recipes/"
  }
];

/** The suggested first steps on /learn/, as docs paths. Pages that do not exist yet are skipped. */
export const START_HERE: string[] = [
  "/learn/mcp/what-is-mcp",
  "/learn/agents/what-is-an-ai-agent",
  "/recipes/zero-key-mcp-agent",
  "/learn/security/prompt-injection",
  "/learn/testing/regression-testing-agents"
];

export const trackById = (id: string): Track | undefined => TRACKS.find((track) => track.id === id);

/** `learn/agents/what-is-an-ai-agent.md` → { track: "agents", slug: "what-is-an-ai-agent" }. */
export function guideOf(relativePath: string): { track: string; slug: string } | null {
  const match = relativePath.match(/^learn\/([^/]+)\/([^/]+)\.md$/);
  return match && match[2] !== "index" ? { track: match[1], slug: match[2] } : null;
}

export interface TrackStep {
  /** Docs path, `/learn/agents/what-is-an-ai-agent`. */
  path: string;
  /** For a guide: its track's title when the step leaves the track. */
  label?: string;
}

export interface TrackPosition {
  track: Track;
  /** Position among the published guides of the track, from 0. */
  index: number;
  /** The published guides of the track, in order. */
  published: string[];
  previous: string | null;
  /** The next guide in the track, or the hand-off when this is the last published one. */
  next: TrackStep | null;
  nextLeavesTrack: boolean;
}

/**
 * Where a guide sits in its track. `exists` says whether a docs path is published
 * (`/learn/agents/what-is-an-ai-agent`), so unwritten guides are skipped.
 */
export function trackPositionOf(relativePath: string, exists: (path: string) => boolean): TrackPosition | null {
  const guide = guideOf(relativePath);
  const track = guide ? trackById(guide.track) : undefined;
  if (!guide || !track || !track.pages.includes(guide.slug)) return null;
  const pathOf = (slug: string, id = track.id) => `/learn/${id}/${slug}`;
  const published = track.pages.filter((slug) => slug === guide.slug || exists(pathOf(slug)));
  const index = published.indexOf(guide.slug);
  const previous = index > 0 ? pathOf(published[index - 1]) : null;
  if (index < published.length - 1) {
    return { track, index, published, previous, next: { path: pathOf(published[index + 1]) }, nextLeavesTrack: false };
  }
  // The last published guide: hand over to the next track's first published guide, or to a docs page.
  let target = track.next;
  const seen = new Set([track.id]);
  while (!target.startsWith("/")) {
    const following = trackById(target);
    if (!following || seen.has(following.id)) break;
    seen.add(following.id);
    const first = following.pages.find((slug) => exists(pathOf(slug, following.id)));
    if (first) return { track, index, published, previous, next: { path: pathOf(first, following.id), label: following.title }, nextLeavesTrack: true };
    target = following.next;
  }
  // A docs path may be a guide in another track: label it with that track, like a track hand-off.
  const targetTrack = target.startsWith("/") ? (guideOf(`${target.slice(1)}.md`)?.track ?? "") : "";
  const label = targetTrack && targetTrack !== track.id ? trackById(targetTrack)?.title : undefined;
  const next = target.startsWith("/") && exists(target) ? { path: target, ...(label ? { label } : {}) } : { path: "/learn/" };
  return { track, index, published, previous, next, nextLeavesTrack: true };
}
