/**
 * Collection functions for `|>` pipelines. Each one works with plain functions and with functions
 * that perform I/O: `map` and `filter` then run every call concurrently, while `each`, `reduce`,
 * `find`, `some` and `every` keep going one element at a time (order matters for them).
 */

type MaybePromise<T> = T | Promise<T>;

function isPromise(value: unknown): value is Promise<unknown> {
  return typeof (value as { then?: unknown } | null)?.then === "function";
}

export function map<T, U>(list: readonly T[], fn: (item: T, index: number) => Promise<U>): Promise<U[]>;
export function map<T, U>(list: readonly T[], fn: (item: T, index: number) => U): U[];
export function map<T, U>(list: readonly T[], fn: (item: T, index: number) => MaybePromise<U>): MaybePromise<U[]> {
  const results = list.map(fn);
  return results.some(isPromise) ? Promise.all(results) : (results as U[]);
}

export function filter<T>(list: readonly T[], fn: (item: T, index: number) => Promise<boolean>): Promise<T[]>;
export function filter<T>(list: readonly T[], fn: (item: T, index: number) => boolean): T[];
export function filter<T>(list: readonly T[], fn: (item: T, index: number) => MaybePromise<boolean>): MaybePromise<T[]> {
  const keep = list.map(fn);
  if (keep.some(isPromise)) return Promise.all(keep).then((flags) => list.filter((_, i) => flags[i]));
  return list.filter((_, i) => keep[i]);
}

/** Runs `step` for each element in order, switching to async mode at the first promise. */
function sequential<T, S>(list: readonly T[], state: S, step: (state: S, item: T, index: number) => MaybePromise<{ state: S; stop?: boolean }>): MaybePromise<S> {
  for (let i = 0; i < list.length; i++) {
    const r = step(state, list[i]!, i);
    if (isPromise(r)) {
      return (async () => {
        let current = await r;
        if (current.stop) return current.state;
        for (let j = i + 1; j < list.length; j++) {
          current = await step(current.state, list[j]!, j);
          if (current.stop) break;
        }
        return current.state;
      })();
    }
    state = r.state;
    if (r.stop) break;
  }
  return state;
}

const then = <A, B>(value: MaybePromise<A>, fn: (a: A) => B): MaybePromise<B> => (isPromise(value) ? value.then(fn) : fn(value as A));

export function reduce<T, A>(list: readonly T[], initial: A, fn: (acc: A, item: T, index: number) => Promise<A>): Promise<A>;
export function reduce<T, A>(list: readonly T[], initial: A, fn: (acc: A, item: T, index: number) => A): A;
export function reduce<T, A>(list: readonly T[], initial: A, fn: (acc: A, item: T, index: number) => MaybePromise<A>): MaybePromise<A> {
  return sequential(list, initial, (acc, item, i) => then(fn(acc, item, i), (next) => ({ state: next })));
}

export function each<T>(list: readonly T[], fn: (item: T, index: number) => Promise<unknown>): Promise<void>;
export function each<T>(list: readonly T[], fn: (item: T, index: number) => unknown): void;
export function each<T>(list: readonly T[], fn: (item: T, index: number) => unknown): MaybePromise<void> {
  return then(
    sequential(list, undefined, (_, item, i) => then(fn(item, i), () => ({ state: undefined }))),
    () => undefined,
  );
}

export function find<T>(list: readonly T[], fn: (item: T, index: number) => Promise<boolean>): Promise<T | null>;
export function find<T>(list: readonly T[], fn: (item: T, index: number) => boolean): T | null;
export function find<T>(list: readonly T[], fn: (item: T, index: number) => MaybePromise<boolean>): MaybePromise<T | null> {
  return sequential<T, T | null>(list, null, (_, item, i) => then(fn(item, i), (hit) => ({ state: hit ? item : null, stop: hit })));
}

export function some<T>(list: readonly T[], fn: (item: T, index: number) => Promise<boolean>): Promise<boolean>;
export function some<T>(list: readonly T[], fn: (item: T, index: number) => boolean): boolean;
export function some<T>(list: readonly T[], fn: (item: T, index: number) => MaybePromise<boolean>): MaybePromise<boolean> {
  return sequential(list, false, (_, item, i) => then(fn(item, i), (hit) => ({ state: hit, stop: hit })));
}

export function every<T>(list: readonly T[], fn: (item: T, index: number) => Promise<boolean>): Promise<boolean>;
export function every<T>(list: readonly T[], fn: (item: T, index: number) => boolean): boolean;
export function every<T>(list: readonly T[], fn: (item: T, index: number) => MaybePromise<boolean>): MaybePromise<boolean> {
  return sequential(list, true, (_, item, i) => then(fn(item, i), (ok) => ({ state: ok, stop: !ok })));
}

export function sortBy<T>(list: readonly T[], key: (item: T) => Promise<unknown>): Promise<T[]>;
export function sortBy<T>(list: readonly T[], key: (item: T) => unknown): T[];
export function sortBy<T>(list: readonly T[], key: (item: T) => unknown): MaybePromise<T[]> {
  const keys = list.map((item) => key(item));
  const order = (resolved: unknown[]) =>
    list
      .map((item, i) => ({ item, key: resolved[i] }))
      .sort((a, b) => (a.key === b.key ? 0 : (a.key as number) < (b.key as number) ? -1 : 1))
      .map((x) => x.item);
  return keys.some(isPromise) ? Promise.all(keys).then(order) : order(keys);
}

export function sum(list: readonly number[]): number {
  let total = 0;
  for (const n of list) total += n;
  return total;
}

export function take<T>(list: readonly T[], n: number): T[] {
  return list.slice(0, Math.max(0, n));
}
