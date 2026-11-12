// The Learn section's tracks: the order a reader goes through the guides in. One place drives the
// Learn sidebar, the track cards on /learn/, each guide's header and its "next / previous in track"
// links, and the TechArticle JSON-LD. Imports nothing from Node, so the theme can use it too.
//
// To add a guide: write docs/learn/<slug>.md (see the template in learn/index.md's comment) and add
// "<slug>" to the `pages` of exactly one track, in reading order. A guide that is in no track still
// builds, but the build warns and it has no track header or next/previous links.

export type Level = "beginner" | "intermediate" | "advanced";

export const LEVEL_LABELS: Record<Level, string> = {
  beginner: "Beginner",
  intermediate: "Intermediate",
  advanced: "Advanced"
};

export interface Track {
  /** Stable id, used in anchors on /learn/ (`#track-<id>`). */
  id: string;
  title: string;
  /** One or two plain sentences for the track card. */
  summary: string;
  level: Level;
  /** Guide slugs under learn/, in reading order. */
  pages: string[];
}

export const TRACKS: Track[] = [
  {
    id: "agent-fundamentals",
    title: "Agent fundamentals",
    summary: "What a tool-calling agent is, how its loop runs, and where MCP fits in.",
    level: "beginner",
    pages: ["how-agent-loops-work"]
  }
];

export interface TrackPosition {
  track: Track;
  index: number;
  previous: string | null;
  next: string | null;
}

/** Where a guide sits in its track, by slug (`how-agent-loops-work`). */
export function trackPositionOf(slug: string): TrackPosition | null {
  for (const track of TRACKS) {
    const index = track.pages.indexOf(slug);
    if (index >= 0) {
      return {
        track,
        index,
        previous: index > 0 ? track.pages[index - 1] : null,
        next: index < track.pages.length - 1 ? track.pages[index + 1] : null
      };
    }
  }
  return null;
}
