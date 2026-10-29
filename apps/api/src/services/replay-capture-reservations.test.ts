/**
 * Phase 13.1 — the replay-capture daily limit with database reservations (cluster mode): two capture services on one
 * store stand in for two instances deciding at the same time; together they never take more slots than the limit, a
 * given-back slot is free again for either, and the settings view counts live reservations. Without reservations the
 * in-process count is used, as before.
 */
import { afterEach, describe, expect, it } from "vitest";
import { ReplayCaptureService, seededRandom, type CaptureReservations } from "./replay-capture-service.js";
import { createTestStore, type TestStore } from "../test-support/test-store.js";

const SURROGATE_KEY = new Uint8Array(32).fill(7);

describe("replay capture reservations across instances", () => {
  let testStore: TestStore | undefined;
  afterEach(async () => {
    await testStore?.cleanup();
    testStore = undefined;
  });

  async function setup(maxPerDay: number) {
    testStore = await createTestStore();
    const store = testStore.store;
    await store.upsertWorkflow({ id: "wf-cap", name: "wf-cap", schemaVersion: "1.0.0", workflowVersion: 1, nodes: [], edges: [] });
    await store.saveReplayCaptureSettings({ workflowId: "wf-cap", enabled: true, rate: 1, maxPerDay, onlyStatuses: ["success"], dlp: true, dlpOffReason: null, targetDatasetId: null, updatedBy: null });
    let counter = 0;
    const reservations: CaptureReservations = {
      reserve: async (input) => {
        counter += 1;
        const id = `res-${counter}`;
        return (await store.reserveReplayCapture({ id, ...input })) ? id : null;
      },
      release: async (id) => await store.releaseReplayCaptureReservation(id),
      countLive: async (workflowId) => await store.countReplayCaptureReservations(workflowId)
    };
    const make = (withReservations: boolean) =>
      new ReplayCaptureService({
        store,
        recordings: {} as never,
        datasets: {} as never,
        surrogateKey: SURROGATE_KEY,
        dictionariesFor: async () => [],
        dictionaryClasses: async () => [],
        publishedVersion: async () => null,
        deployment: { enabled: true, maxRate: 1, retentionDays: 14, maxPerWorkflow: 200, maxBytesPerWorkflow: 209_715_200 },
        random: seededRandom(1),
        log: { warn: () => undefined, info: () => undefined },
        ...(withReservations ? { reservations } : {})
      });
    return { store, make };
  }

  const decide = (service: ReplayCaptureService) =>
    service.decide({ workflow: { id: "wf-cap" }, channel: "production", triggerType: "webhook", releaseVersion: null, excluded: false, runTimeoutMs: 60_000 });

  it("two instances deciding at once never take more than the daily limit", async () => {
    const { store, make } = await setup(4);
    const one = make(true);
    const two = make(true);
    const tickets = await Promise.all(Array.from({ length: 10 }, (_, index) => decide(index % 2 === 0 ? one : two)));
    const granted = tickets.filter((ticket) => ticket !== null);
    expect(granted).toHaveLength(4);
    expect(granted.every((ticket) => typeof ticket!.reservationId === "string")).toBe(true);
    expect(await store.countReplayCaptureReservations("wf-cap")).toBe(4);
    expect((await one.view("wf-cap")).capturedToday).toBe(4);
    // A slot given back on one instance is free for the other.
    one.abandon(granted[0]!);
    const next = await (async () => {
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const ticket = await decide(two);
        if (ticket) return ticket;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return null;
    })();
    expect(next).not.toBeNull();
    expect(await decide(one)).toBeNull();
  });

  it("without reservations each instance counts only its own runs in flight (single-instance behaviour)", async () => {
    const { store, make } = await setup(1);
    const one = make(false);
    const two = make(false);
    const first = await decide(one);
    expect(first).not.toBeNull();
    expect(first!.reservationId).toBeUndefined();
    expect(await decide(one)).toBeNull();
    // A second process cannot see the first one's run in flight: this is the overshoot reservations remove.
    expect(await decide(two)).not.toBeNull();
    expect(await store.countReplayCaptureReservations("wf-cap")).toBe(0);
  });
});
