import { PostgresStore } from "./postgres-store.js";
import type { Store } from "./store.js";

/**
 * Whether `store` really implements `method`. Every store has every method
 * (the Store interface), but the Postgres store answers some of them with
 * StoreNotImplementedError until it reaches parity, so features that turn
 * themselves off without a method ask here.
 */
export function storeImplements(store: Store, method: keyof Store): boolean {
  return !((store as object) instanceof PostgresStore && PostgresStore.unimplemented.has(method));
}
