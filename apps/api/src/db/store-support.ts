import { PostgresStore } from "./postgres-store.js";
import type { Store } from "./store.js";

/**
 * Whether `store` really implements `method`. Every store has every method
 * (the Store interface); a Postgres store lists in its class's `unimplemented`
 * any method it answers with StoreNotImplementedError (none today, now that
 * every domain is ported), so features that turn themselves off without a
 * method ask here. The set is read from the store's own class, so a subclass
 * (or a test) can declare its own.
 */
export function storeImplements(store: Store, method: keyof Store): boolean {
  if (!((store as object) instanceof PostgresStore)) return true;
  const own = (store.constructor as { unimplemented?: ReadonlySet<keyof Store> }).unimplemented;
  return !(own ?? PostgresStore.unimplemented).has(method);
}
