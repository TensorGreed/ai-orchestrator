// Small helpers shared by the knowledge-hub components.
import { SITE } from "../site/sections.js";

/** A site URL as a path on the current origin (https://lsquarem.com/docs/x → /docs/x), so links work in previews too. */
export function sitePath(url: string): string {
  return url.startsWith(SITE) ? url.slice(SITE.length) || "/" : url;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** `2026-11-12` or a timestamp → "12 November 2026", the same on the server and in the browser (UTC). */
export function formatDate(value: string | number): string {
  const date = typeof value === "number" ? new Date(value) : new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** `2026-11-12` or a timestamp → the ISO date for a <time datetime>. */
export function isoDay(value: string | number): string {
  const date = typeof value === "number" ? new Date(value) : new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
}

/** The live demo, opened on a workflow; `recorded` also plays its recorded run. */
export function demoHref(workflowId: string, recorded = false): string {
  const params = new URLSearchParams({ mode: "editor", workflowId });
  if (recorded) params.set("demoRun", "recorded");
  return `/demo/?${params.toString()}`;
}
