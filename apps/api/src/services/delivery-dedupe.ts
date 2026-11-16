/**
 * Remembers delivery ids (a Slack event_id, a GitHub X-GitHub-Delivery) for a short window so a redelivered event
 * starts no second run. In memory and per instance: with EXECUTION_DISPATCH=queue the Slack route also hands the id
 * to the queue, which dedupes across instances.
 */
export class DeliveryDedupe {
  private readonly seenUntil = new Map<string, number>();

  constructor(
    private readonly windowMs: number,
    private readonly maxEntries = 10_000,
    private readonly now: () => number = Date.now
  ) {}

  /** True when `key` was already recorded within the window; otherwise records it and answers false. */
  seen(key: string): boolean {
    const at = this.now();
    const until = this.seenUntil.get(key);
    if (until !== undefined && until > at) return true;
    this.prune(at);
    this.seenUntil.set(key, at + this.windowMs);
    return false;
  }

  /** Forgets `key` (a delivery that was refused before it started a run may come again). */
  forget(key: string): void {
    this.seenUntil.delete(key);
  }

  get size(): number {
    return this.seenUntil.size;
  }

  private prune(at: number): void {
    // Insertion order is expiry order (one fixed window), so expired entries are at the front.
    for (const [key, until] of this.seenUntil) {
      if (until > at && this.seenUntil.size < this.maxEntries) break;
      this.seenUntil.delete(key);
    }
  }
}
