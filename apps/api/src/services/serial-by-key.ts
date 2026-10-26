/**
 * Runs the tasks given for one key one after another, in call order, whatever the earlier ones answered; tasks
 * for different keys run independently. Keeps nothing for a key once its queue is empty.
 */
export class SerialByKey {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(task);
    const tail = result.then(
      () => undefined,
      () => undefined
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      // promise-ok: identity check, is this still the last task queued for the key
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }
}

/**
 * Reloads of one key, one after another (SerialByKey), that a removal can overtake: a reload asked for before a
 * removal of its key sees `removedSince()` answer true once it runs, even if the removal came before its turn.
 * Removal counts are kept only while a reload of the key is pending, so nothing is kept for a key afterwards.
 */
export class SerialReloads {
  private readonly serial = new SerialByKey();
  private readonly pending = new Map<string, { reloads: number; removals: number }>();

  async reload(key: string, task: (removedSince: () => boolean) => Promise<void>): Promise<void> {
    let entry = this.pending.get(key);
    if (!entry) {
      entry = { reloads: 0, removals: 0 };
      this.pending.set(key, entry);
    }
    const own = entry;
    own.reloads += 1;
    // Counted when the reload is asked for: a removal after that, even before this reload's turn, wins.
    const seen = own.removals;
    try {
      await this.serial.run(key, async () => await task(() => own.removals !== seen));
    } finally {
      own.reloads -= 1;
      if (own.reloads === 0 && this.pending.get(key) === own) this.pending.delete(key);
    }
  }

  /** The key was removed: every reload of it already asked for skips its registration. */
  removed(key: string): void {
    const entry = this.pending.get(key);
    if (entry) entry.removals += 1;
  }

  /** How many keys have a reload pending (what is kept in memory). */
  get tracked(): number {
    return this.pending.size;
  }
}
