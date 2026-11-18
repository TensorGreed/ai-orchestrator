// Reads a PDF's text in a worker thread (started by pdf.ts with memory limits, a kill timer and an empty environment).
//
// Plain JavaScript on purpose: the worker runs without the TypeScript loader. It reads, for each page up to
// `maxPages`, the text layer (as lines), the text of comments and their authors, form field values and link
// addresses, and the document properties. It never renders, never loads system fonts, never fetches anything (the
// character maps and standard font data are read from the pdfjs-dist package folder), and stops reading once
// `maxChars` characters of text are collected. Nothing is logged: the console is silenced before pdf.js loads, so no
// warning can carry document text into the logs.
//
// Answer (posted once): { ok: true, numPages, pages: [{ text, items: [{ part, item, text }] }], properties: [{ name, text }],
// stoppedAtChars } or { ok: false, code: "password" | "invalid" | "nesting" }.

import { parentPort, workerData } from "node:worker_threads";

for (const method of ["log", "info", "warn", "error", "debug", "trace", "dir", "table"]) {
  console[method] = () => {};
}

const { bytes, maxPages, maxChars, assetRoot } = workerData;

const PROPERTY_NAMES = ["Title", "Author", "Subject", "Keywords", "Creator", "Producer"];

/** Joins a page's text items into lines: an item ending a line (hasEOL) starts a new one. */
function pageText(items) {
  let text = "";
  for (const item of items) {
    if (typeof item.str !== "string") continue;
    text += item.str;
    if (item.hasEOL) text += "\n";
  }
  return text.replace(/[ \t]+\n/g, "\n").replace(/\n+$/, "");
}

function str(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * The text an annotation holds: a comment and its author, a text or choice field's value, a link's address. `item` is
 * the annotation's 1-based position among the page's annotations of its kind (a comment and its author share it).
 */
function annotationItems(annotations) {
  const items = [];
  const counts = { comment: 0, form_field: 0, link: 0 };
  for (const annotation of annotations) {
    if (annotation.subtype === "Widget") {
      // Text and choice fields; check boxes and radio buttons only hold a state name (Yes, Off, ...).
      if (annotation.fieldType !== "Tx" && annotation.fieldType !== "Ch") continue;
      const item = ++counts.form_field;
      const value = Array.isArray(annotation.fieldValue) ? annotation.fieldValue.filter((entry) => typeof entry === "string").join("\n").trim() : str(annotation.fieldValue);
      if (value) items.push({ part: "form_field", item, text: value });
      continue;
    }
    if (annotation.subtype === "Link") {
      const item = ++counts.link;
      const url = str(annotation.url) || str(annotation.unsafeUrl);
      if (url) items.push({ part: "link", item, text: url });
      continue;
    }
    if (annotation.subtype === "Popup") continue;
    const item = ++counts.comment;
    const contents = str(annotation.contentsObj?.str);
    const richText = Array.isArray(annotation.textContent) ? annotation.textContent.filter((entry) => typeof entry === "string").join("\n").trim() : "";
    const comment = contents || richText;
    if (comment) items.push({ part: "comment", item, text: comment });
    const author = str(annotation.titleObj?.str);
    if (author) items.push({ part: "comment_author", item, text: author });
  }
  return items;
}

/** The document information dictionary's text properties, its custom ones, and the XMP metadata values. */
function propertyItems(metadata) {
  const items = [];
  const info = metadata?.info ?? {};
  for (const name of PROPERTY_NAMES) {
    const value = str(info[name]);
    if (value) items.push({ name, text: value });
  }
  const custom = info.Custom && typeof info.Custom === "object" ? info.Custom : {};
  for (const value of Object.values(custom)) {
    const text = str(value);
    if (text) items.push({ name: "custom property", text });
  }
  const xmp = metadata?.metadata;
  if (xmp && typeof xmp.getAll === "function") {
    for (const [key, value] of Object.entries(xmp.getAll())) {
      const text = Array.isArray(value) ? value.filter((entry) => typeof entry === "string").join("\n").trim() : str(value);
      if (text) items.push({ name: /^[a-z]{1,16}:[A-Za-z]{1,32}$/.test(key) ? `XMP ${key}` : "XMP property", text });
    }
  }
  return items;
}

async function read() {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  // The parser runs in this thread (no nested worker): pdf.js uses a handler already on globalThis.
  globalThis.pdfjsWorker = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
  const task = pdfjs.getDocument({
    data: bytes,
    // Fonts are never compiled to JavaScript (CVE-2024-4367; the option is gone from current pdf.js, which no longer
    // has an eval path; kept so an older build could never turn it on), never loaded as font faces, never system fonts.
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    // A broken document is refused instead of being half-recovered.
    stopAtErrors: true,
    enableXfa: false,
    // Nothing is fetched: no ranges, no streaming, and local copies of the package's data files.
    disableRange: true,
    disableStream: true,
    disableAutoFetch: true,
    useWorkerFetch: false,
    cMapUrl: `${assetRoot}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${assetRoot}standard_fonts/`,
    wasmUrl: `${assetRoot}wasm/`,
    iccUrl: `${assetRoot}iccs/`,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    verbosity: pdfjs.VerbosityLevel.ERRORS
  });
  // An encrypted document opens only with the empty password (pdf.js tries it first); asked for another, it is refused.
  task.onPassword = () => {
    // The parent stops this worker on the first answer.
    parentPort.postMessage({ ok: false, code: "password" });
  };
  const doc = await task.promise;
  const pages = [];
  let chars = 0;
  let stoppedAtChars = false;
  const budget = () => Math.max(0, maxChars + 1 - chars);
  const last = Math.min(doc.numPages, maxPages);
  for (let number = 1; number <= last; number += 1) {
    const page = await doc.getPage(number);
    const content = await page.getTextContent({ includeMarkedContent: false, disableNormalization: false });
    // Text past the character limit (plus one, so the caller sees it was passed) is never sent back.
    const text = pageText(content.items).slice(0, budget());
    chars += text.length;
    const items = [];
    for (const item of annotationItems(await page.getAnnotations({ intent: "display" }))) {
      if (budget() === 0) break;
      const kept = { ...item, text: item.text.slice(0, budget()) };
      chars += kept.text.length;
      items.push(kept);
    }
    pages.push({ text, items });
    page.cleanup();
    if (chars > maxChars) {
      stoppedAtChars = number < doc.numPages;
      break;
    }
  }
  const properties = [];
  for (const property of propertyItems(await doc.getMetadata().catch(() => null))) {
    if (budget() === 0) break;
    const text = property.text.slice(0, budget());
    chars += text.length;
    properties.push({ name: property.name, text });
  }
  return { ok: true, numPages: doc.numPages, pages, properties, stoppedAtChars };
}

function failure(error) {
  const name = error && typeof error === "object" ? error.name : "";
  const message = error && typeof error === "object" && typeof error.message === "string" ? error.message : "";
  if (name === "PasswordException") return { ok: false, code: "password" };
  // A stack overflow in the parser (a RangeError, or pdf.js's own error carrying its text).
  if (/call stack/i.test(message)) return { ok: false, code: "nesting" };
  return { ok: false, code: "invalid" };
}

// The parent stops this worker once it has the answer (pdf.js may keep message ports open).
read().then(
  (answer) => parentPort.postMessage(answer),
  (error) => parentPort.postMessage(failure(error))
);
