// Node-side helpers for the config: read the hub sections' pages from disk to build sidebars, the
// blog feed and breadcrumbs. VitePress itself parses frontmatter for the pages; these helpers only
// read the simple keys the hub needs, so the hub templates keep those keys flat:
//   key: value | key: "quoted value" | key: [a, b] | key:\n  - a\n  - b
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

/** The pages of one hub folder (not its index), sorted by file name. */
export function pagesIn(folder: string): SourcePage[] {
  const dir = path.join(SRC_DIR, folder);
  if (!existsSync(dir)) return [];
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
    });
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
