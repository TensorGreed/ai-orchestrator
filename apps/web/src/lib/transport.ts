/**
 * The network seam of the API client: every request in `api.ts` goes through
 * `apiFetch`, every server-sent event stream through `openEventSource`.
 *
 * The static demo build (`vite build --mode demo`) swaps this module for
 * `src/demo/demo-transport.ts`, which answers in the browser; normal builds
 * never reference that module. Globals are read at call time so tests can stub
 * them.
 */
export function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  return fetch(input, init);
}

export function openEventSource(url: string, init?: EventSourceInit): EventSource {
  return new EventSource(url, init);
}
