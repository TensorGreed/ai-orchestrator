import { Parser } from "htmlparser2";

/**
 * HTML to text without a DOM and without running anything: a streaming tokenizer (htmlparser2) keeps the visible
 * text, with line breaks at block elements, and drops script, style, noscript, template, iframe, object and svg
 * content and comments. Text the page hides (the `hidden` attribute, `aria-hidden="true"`, inline `display:none` or
 * `visibility:hidden`) is kept apart, and so are `alt`, `title`, `aria-label`, `placeholder` and form `value`
 * attributes and `<meta>` content, so data a reader does not see is still checked.
 */

const SKIPPED = new Set(["script", "style", "noscript", "template", "iframe", "object", "embed", "svg", "math", "canvas"]);

const BLOCK = new Set([
  "address", "article", "aside", "blockquote", "br", "caption", "dd", "details", "dialog", "div", "dl", "dt", "fieldset",
  "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol",
  "p", "pre", "section", "summary", "table", "tbody", "td", "tfoot", "th", "thead", "title", "tr", "ul", "option", "textarea", "label", "legend"
]);

const TEXT_ATTRIBUTES = ["alt", "title", "aria-label", "placeholder"] as const;
const VALUE_TAGS = new Set(["input", "option", "button", "data", "param"]);

export interface HtmlAttributeText {
  tag: string;
  attribute: string;
  text: string;
}

export interface HtmlText {
  visible: string;
  hidden: string;
  attributes: HtmlAttributeText[];
}

function hides(attribs: Record<string, string>): boolean {
  if ("hidden" in attribs) return true;
  if ((attribs["aria-hidden"] ?? "").trim().toLowerCase() === "true") return true;
  const style = (attribs.style ?? "").toLowerCase().replace(/\s+/g, "");
  return style.includes("display:none") || style.includes("visibility:hidden");
}

/** Collapses runs of spaces within lines, trims each line and keeps at most one blank line between blocks. */
export function normalizeExtractedText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function extractHtmlText(html: string, maxAttributes = 10_000): HtmlText {
  const visible: string[] = [];
  const hidden: string[] = [];
  const attributes: HtmlAttributeText[] = [];
  // One entry per open element: whether it starts a skipped or hidden region.
  const stack: Array<{ name: string; skip: boolean; hide: boolean }> = [];
  let skipDepth = 0;
  let hideDepth = 0;
  const sink = () => (hideDepth > 0 ? hidden : visible);

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        const skip = SKIPPED.has(name);
        const hide = !skip && hides(attribs);
        stack.push({ name, skip, hide });
        if (skip) skipDepth += 1;
        if (hide) hideDepth += 1;
        if (skipDepth > 0) return;
        if (BLOCK.has(name)) sink().push("\n");
        else if (name === "td" || name === "th") sink().push("\t");
        if (attributes.length < maxAttributes) {
          for (const attribute of TEXT_ATTRIBUTES) {
            const value = attribs[attribute]?.trim();
            if (value) attributes.push({ tag: name, attribute, text: value });
          }
          const value = attribs.value?.trim();
          if (value && VALUE_TAGS.has(name)) attributes.push({ tag: name, attribute: "value", text: value });
          const content = attribs.content?.trim();
          if (content && name === "meta") attributes.push({ tag: name, attribute: "content", text: content });
        }
      },
      ontext(text) {
        if (skipDepth > 0) return;
        sink().push(text);
      },
      onclosetag(name) {
        // htmlparser2 closes every element it opened (implied closes included), innermost first.
        let index = stack.length - 1;
        while (index >= 0 && stack[index]!.name !== name) index -= 1;
        if (index < 0) return;
        while (stack.length > index) {
          const entry = stack.pop()!;
          if (entry.skip) skipDepth -= 1;
          if (entry.hide) hideDepth -= 1;
          if (skipDepth === 0 && BLOCK.has(entry.name)) sink().push("\n");
        }
      }
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true, recognizeCDATA: false }
  );
  parser.write(html);
  parser.end();
  return { visible: normalizeExtractedText(visible.join("")), hidden: normalizeExtractedText(hidden.join("")), attributes };
}
