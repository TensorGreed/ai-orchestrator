// Node-side helpers for the config: read the hub sections' pages from disk to build sidebars, the
// blog feed and breadcrumbs. VitePress itself parses frontmatter for the pages; these helpers only
// read the simple keys the hub needs, so the hub templates keep those keys flat:
//   key: value | key: "quoted value" | key: [a, b] | key:\n  - a\n  - b
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SRC_DIR = fileURLToPath(new URL("../../", import.meta.url));

export type Frontmatter = Record<string, string | string[]>;

function scalar(raw: string): string {
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) return value.slice(1, -1).replace(/''/g, "'");
  return value;
}

/** The flat keys of a Markdown file's YAML frontmatter (see the header comment for the forms). */
export function readFrontmatter(source: string): Frontmatter {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const data: Frontmatter = {};
  if (!match) return data;
  let listKey: string | null = null;
  for (const line of match[1].split(/\r?\n/)) {
    const item = line.match(/^\s+-\s+(.*)$/);
    if (item && listKey) {
      (data[listKey] as string[]).push(scalar(item[1]));
      continue;
    }
    const pair = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!pair) {
      listKey = null;
      continue;
    }
    const [, key, rest] = pair;
    if (rest.trim() === "") {
      data[key] = [];
      listKey = key;
    } else if (rest.trim().startsWith("[") && rest.trim().endsWith("]")) {
      data[key] = rest.trim().slice(1, -1).split(",").map(scalar).filter((value) => value !== "");
      listKey = null;
    } else {
      data[key] = scalar(rest);
      listKey = null;
    }
  }
  return data;
}

export interface SourcePage {
  /** Path relative to the docs source, `learn/foo.md`. */
  relativePath: string;
  slug: string;
  frontmatter: Frontmatter;
  /** The page's first `# ` heading, when it has one. */
  heading: string;
  body: string;
}

/** The pages of one hub folder (not its index), sorted by file name; `deep` also reads sub-folders. */
export function pagesIn(folder: string, deep = false): SourcePage[] {
  const dir = path.join(SRC_DIR, folder);
  if (!existsSync(dir)) return [];
  const sub = deep
    ? readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .flatMap((entry) => pagesIn(`${folder}/${entry.name}`, true))
    : [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md") && name !== "index.md")
    .sort()
    .map((name) => {
      const source = readFileSync(path.join(dir, name), "utf8");
      const body = source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
      return {
        relativePath: `${folder}/${name}`,
        slug: name.slice(0, -3),
        frontmatter: readFrontmatter(source),
        heading: body.match(/^#\s+(.+)$/m)?.[1].trim() ?? "",
        body
      };
    })
    .concat(sub);
}

export const text = (value: string | string[] | undefined): string => (Array.isArray(value) ? value.join(", ") : (value ?? ""));
export const list = (value: string | string[] | undefined): string[] => (Array.isArray(value) ? value : value ? [value] : []);

/** Whether a docs folder has an index page. */
export function hasIndex(folder: string): boolean {
  return existsSync(path.join(SRC_DIR, folder, "index.md"));
}

/** Reading time in whole minutes at 220 words a minute, code blocks counted at half weight. */
export function readingMinutes(markdown: string): number {
  const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---/, "");
  const code = [...body.matchAll(/```[\s\S]*?```/g)].map((match) => match[0]).join(" ");
  const prose = body.replace(/```[\s\S]*?```/g, " ").replace(/<[^>]+>/g, " ");
  const words = (value: string) => value.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
  return Math.max(1, Math.round((words(prose) + words(code) / 2) / 220));
}

/** Whether a docs path is a published page: `/learn/agents/x` → learn/agents/x.md, `/learn/` → learn/index.md. */
export function pageExists(docsPath: string): boolean {
  const clean = docsPath.replace(/[?#].*$/, "").replace(/^\//, "");
  const file = clean === "" || clean.endsWith("/") ? `${clean}index.md` : `${clean}.md`;
  return existsSync(path.join(SRC_DIR, file));
}

const firstCommitCache = new Map<string, string | undefined>();

/** The date a page was first committed (ISO 8601), from git; undefined for a file git does not know yet. */
export function firstPublished(relativePath: string): string | undefined {
  if (!firstCommitCache.has(relativePath)) {
    let date: string | undefined;
    try {
      const out = execFileSync("git", ["log", "--diff-filter=A", "--follow", "--format=%cI", "--", relativePath], { cwd: SRC_DIR, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      date = out.split("\n").filter(Boolean).at(-1);
    } catch {
      date = undefined;
    }
    firstCommitCache.set(relativePath, date);
  }
  return firstCommitCache.get(relativePath);
}

/** A per-page share card rendered by scripts/social-card/render-sections.mjs, if one exists. */
export function pageSocialCard(relativePath: string): string | null {
  const name = `${relativePath.replace(/\.md$/, "").replace(/\//g, "--")}.png`;
  return existsSync(path.join(SRC_DIR, "public", "social", "pages", name)) ? `/social/pages/${name}` : null;
}
