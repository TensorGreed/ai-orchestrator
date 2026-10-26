/**
 * Stands in for `src/lib/transport.ts` in the demo build (see the `demoMode`
 * plugin in vite.config.ts): requests are answered by the in-browser fake
 * backend, never by the network.
 */
import { createFakeBackend, type DemoNotice } from "./fake-backend";
import { demoFixtures } from "./fixtures";

export const DEMO_NOTICE_EVENT = "l2m-demo:notice";

function browserStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export const demoBackend = createFakeBackend({
  fixtures: demoFixtures,
  storage: browserStorage(),
  notify: (notice: DemoNotice) => window.dispatchEvent(new CustomEvent<DemoNotice>(DEMO_NOTICE_EVENT, { detail: notice }))
});

export function apiFetch(input: string, init?: RequestInit): Promise<Response> {
  return demoBackend.fetch(input, init);
}

export function openEventSource(url: string): EventSource {
  return demoBackend.openEventSource(url);
}
