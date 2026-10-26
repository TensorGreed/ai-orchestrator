/**
 * Array helpers for async predicates and mappers over store reads.
 *
 * Each runs its callback one item at a time, in order, the same order the
 * synchronous `Array` methods use: a callback that writes or audits sees the
 * same sequence as before, and a Postgres pool is not flooded with one query
 * per row at once.
 */

export async function someAsync<T>(items: Iterable<T>, predicate: (item: T, index: number) => boolean | Promise<boolean>): Promise<boolean> {
  let index = 0;
  for (const item of items) {
    if (await predicate(item, index++)) return true;
  }
  return false;
}

export async function everyAsync<T>(items: Iterable<T>, predicate: (item: T, index: number) => boolean | Promise<boolean>): Promise<boolean> {
  let index = 0;
  for (const item of items) {
    if (!(await predicate(item, index++))) return false;
  }
  return true;
}

export async function filterAsync<T, S extends T = T>(items: Iterable<T>, predicate: (item: T, index: number) => boolean | Promise<boolean>): Promise<S[]> {
  const kept: S[] = [];
  let index = 0;
  for (const item of items) {
    if (await predicate(item, index++)) kept.push(item as S);
  }
  return kept;
}

export async function mapAsync<T, R>(items: Iterable<T>, mapper: (item: T, index: number) => R | Promise<R>): Promise<R[]> {
  const mapped: R[] = [];
  let index = 0;
  for (const item of items) mapped.push(await mapper(item, index++));
  return mapped;
}

export async function findAsync<T>(items: Iterable<T>, predicate: (item: T, index: number) => boolean | Promise<boolean>): Promise<T | undefined> {
  let index = 0;
  for (const item of items) {
    if (await predicate(item, index++)) return item;
  }
  return undefined;
}
