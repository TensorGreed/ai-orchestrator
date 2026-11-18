/**
 * The API's own address, offered next to a webhook's app-origin URL on a local dev server, where the web app proxies
 * to the API on another port. `apiPort` is the port the dev server proxies to (set by vite.config.ts); without it the
 * port is unknown and nothing is offered rather than a guess.
 */
export function directApiBaseUrl(options: {
  /** `VITE_API_BASE_URL`: when set, the app already calls the API there. */
  configuredBase?: string;
  apiPort?: string;
  location: { protocol: string; hostname: string };
  /** The base the app-origin URLs use. */
  currentBase: string;
}): string | null {
  if (options.configuredBase?.trim()) return null;
  const { hostname, protocol } = options.location;
  if (hostname !== "localhost" && hostname !== "127.0.0.1") return null;
  const port = options.apiPort?.trim();
  if (!port || !/^\d+$/.test(port)) return null;
  const suggested = `${protocol}//${hostname}:${port}`;
  return suggested === options.currentBase.replace(/\/+$/, "") ? null : suggested;
}
