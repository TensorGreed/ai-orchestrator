// Headings of Markdown pages as plain text (breadcrumb names). No Node imports, so tests and the theme can use it.

/** A page's first `# ` heading as plain text (no inline code, emphasis, links or `{#id}`), or "". */
export function plainHeading(source: string): string {
  const body = source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").replace(/^(```|~~~)[\s\S]*?^\1/gm, "");
  const line = body.match(/^#[ \t]+(.+)$/m)?.[1] ?? "";
  return line
    .replace(/\s*\{#[^}]*\}\s*$/, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^\w*])[*_]([^*_]+)[*_](?![\w*])/g, "$1$2")
    .replace(/<[^>]+>/g, "")
    .trim();
}
