/**
 * Each run's progress writes, chained so they reach the store in the order they were made (the engine does not
 * await activity and MCP-progress hooks, and a pooled store can commit concurrent writes out of order). The run's
 * final write settles the chain first, so no progress write lands after it; the run settles it too when it ends
 * (paused, failed or finished), so nothing is kept for a run once it is over.
 */
export class RunWriteChains {
  private readonly chains = new Map<string, { tail: Promise<void>; closed: boolean }>();

  constructor(private readonly onError: (executionId: string, error: unknown) => void) {}

  /** A new chain for this run (a resume of the same run starts a new one); its writes are queued with `enqueue`. */
  open(executionId: string): { enqueue: (write: () => Promise<void>) => Promise<void> } {
    const chain = { tail: Promise.resolve(), closed: false };
    this.chains.set(executionId, chain);
    return {
      enqueue: (write) => {
        if (chain.closed) return Promise.resolve();
        // A write that rejects is logged and the chain goes on: later writes still run, and the final write's
        // wait for the tail never throws, not even when the logger itself throws. A write queued before the chain
        // is closed still runs: settle waits for it.
        chain.tail = chain.tail.then(write).catch((error: unknown) => {
          try {
            this.onError(executionId, error);
          } catch {
            // The report is best effort; the chain must keep going.
          }
        });
        return chain.tail;
      }
    };
  }

  /** Closes the run's current chain (later writes are dropped) and waits for the writes already queued. */
  async settle(executionId: string): Promise<void> {
    const chain = this.chains.get(executionId);
    if (!chain) return;
    chain.closed = true;
    this.chains.delete(executionId);
    await chain.tail;
  }

  get size(): number {
    return this.chains.size;
  }
}
