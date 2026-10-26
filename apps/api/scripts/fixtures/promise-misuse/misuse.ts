// Fixture for check-floating-promises.test.ts. Lines marked `expect:` must be reported; `clean:` must not.
interface Kb { id: string }
interface MaybeAsyncStore {
  getKnowledgeBase(id: string): Kb | null | Promise<Kb | null>;
  count(): number | Promise<number>;
}

export async function unionCondition(store: MaybeAsyncStore): Promise<string> {
  const kb = store.getKnowledgeBase("kb");
  if (!kb) throw new Error("missing"); // expect: condition
  return "ok";
}

export async function unionNullish(store: MaybeAsyncStore): Promise<unknown> {
  const kb = store.getKnowledgeBase("kb");
  return kb ?? "none"; // expect: condition
}

export async function unionCompared(store: MaybeAsyncStore): Promise<boolean> {
  return store.getKnowledgeBase("kb") === null; // expect: compared
}

export async function plainUnion(store: MaybeAsyncStore): Promise<boolean> {
  const n = store.count();
  return n ? true : false; // expect: condition
}

export async function awaitedIsClean(store: MaybeAsyncStore): Promise<string> {
  const kb = await store.getKnowledgeBase("kb");
  if (!kb) return "missing"; // clean: awaited
  return kb.id;
}

export function existenceCheckIsClean(inFlight: Map<string, Promise<void>>): boolean {
  const running = inFlight.get("x");
  return running ? true : false; // clean: Promise | undefined is an existence check
}

declare function load(id: string): Promise<string>;

export async function tryReturn(id: string): Promise<string | null> {
  try {
    return load(id); // expect: try-return
  } catch {
    return null;
  }
}

export async function tryReturnAwaited(id: string): Promise<string | null> {
  try {
    return await load(id); // clean: awaited inside try
  } catch {
    return null;
  }
}

export function returnOutsideTry(id: string): Promise<string> {
  try {
    void id;
  } finally {
    // nothing
  }
  return load(id); // clean: not inside the try block
}

export async function tryNestedCallback(id: string): Promise<() => Promise<string>> {
  try {
    return async () => load(id); // clean: the return belongs to the inner function
  } catch {
    return async () => "";
  }
}

export async function catchReturnWithFinally(id: string, release: () => void): Promise<string> {
  try {
    return await load(id);
  } catch {
    return load(`${id}-fallback`); // expect: try-return
  } finally {
    release();
  }
}

export async function catchReturnWithoutFinally(id: string): Promise<string> {
  try {
    return await load(id);
  } catch {
    return load(`${id}-fallback`); // clean: no finally, so nothing here would see the rejection
  }
}
