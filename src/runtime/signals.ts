/**
 * A small push-pull reactive core: signals hold values, computeds derive lazily and cache,
 * effects re-run (after the current batch) whenever something they read changes.
 */

interface Source {
  observers: Set<Observer>;
}

interface Observer {
  sources: Set<Source>;
  markDirty(): void;
}

let currentObserver: Observer | undefined;
let batchDepth = 0;
const pendingEffects = new Set<EffectNode>();
const MAX_FLUSH_ROUNDS = 100;

function track(source: Source): void {
  if (!currentObserver) return;
  source.observers.add(currentObserver);
  currentObserver.sources.add(source);
}

function unsubscribe(observer: Observer): void {
  for (const source of observer.sources) source.observers.delete(observer);
  observer.sources.clear();
}

function notify(source: Source): void {
  for (const observer of [...source.observers]) observer.markDirty();
  if (batchDepth === 0) flush();
}

let flushing = false;

function flush(): void {
  // Writes made by a running effect are picked up by the loop below, not by a nested flush.
  if (flushing) return;
  flushing = true;
  try {
    let rounds = 0;
    while (pendingEffects.size > 0) {
      if (++rounds > MAX_FLUSH_ROUNDS) {
        pendingEffects.clear();
        throw new Error("mk: effects keep re-triggering each other (possible cycle)");
      }
      const effects = [...pendingEffects];
      pendingEffects.clear();
      for (const effect of effects) effect.run();
    }
  } finally {
    flushing = false;
  }
}

export class Signal<T> implements Source {
  readonly observers = new Set<Observer>();

  constructor(private current: T) {}

  get value(): T {
    track(this);
    return this.current;
  }

  set value(next: T) {
    if (Object.is(next, this.current)) return;
    this.current = next;
    notify(this);
  }

  /** Read without subscribing. */
  peek(): T {
    return this.current;
  }

  /** Calls `fn` now and on every change; returns an unsubscribe function. */
  subscribe(fn: (value: T) => void): () => void {
    return effect(() => fn(this.value));
  }

  toString(): string {
    return String(this.current);
  }

  toJSON(): T {
    return this.current;
  }
}

export class Computed<T> implements Source, Observer {
  readonly observers = new Set<Observer>();
  readonly sources = new Set<Source>();
  private current!: T;
  private dirty = true;
  private computing = false;

  constructor(private readonly fn: () => T) {}

  get value(): T {
    track(this);
    if (this.dirty) this.recompute();
    return this.current;
  }

  peek(): T {
    if (this.dirty) this.recompute();
    return this.current;
  }

  markDirty(): void {
    if (this.dirty) return;
    this.dirty = true;
    for (const observer of [...this.observers]) observer.markDirty();
  }

  private recompute(): void {
    if (this.computing) throw new Error("mk: derived signal depends on itself");
    this.computing = true;
    unsubscribe(this);
    const saved = currentObserver;
    currentObserver = this;
    try {
      this.current = this.fn();
      this.dirty = false;
    } finally {
      currentObserver = saved;
      this.computing = false;
    }
  }

  toString(): string {
    return String(this.peek());
  }

  toJSON(): T {
    return this.peek();
  }
}

class EffectNode implements Observer {
  readonly sources = new Set<Source>();
  private disposed = false;

  constructor(private readonly fn: () => unknown) {}

  run(): void {
    if (this.disposed) return;
    unsubscribe(this);
    const saved = currentObserver;
    currentObserver = this;
    try {
      // Only reads before the first `await` of an async effect are tracked.
      const result = this.fn();
      if (result instanceof Promise) result.catch((e) => queueMicrotask(() => { throw e; }));
    } finally {
      currentObserver = saved;
    }
  }

  markDirty(): void {
    if (!this.disposed) pendingEffects.add(this);
  }

  dispose(): void {
    this.disposed = true;
    unsubscribe(this);
    pendingEffects.delete(this);
  }
}

export function signal<T>(value: T): Signal<T> {
  return new Signal(value);
}

export function computed<T>(fn: () => T): Computed<T> {
  return new Computed(fn);
}

/** Runs `fn` now and again whenever a signal it read changes. Returns a dispose function. */
export function effect(fn: () => unknown): () => void {
  const node = new EffectNode(fn);
  node.run();
  return () => node.dispose();
}

/** Applies several signal writes, then runs affected effects once. */
export function batch<T>(fn: () => T): T {
  batchDepth++;
  try {
    return fn();
  } finally {
    if (--batchDepth === 0) flush();
  }
}

/** Reads signals inside `fn` without subscribing the current effect / computed to them. */
export function untrack<T>(fn: () => T): T {
  const saved = currentObserver;
  currentObserver = undefined;
  try {
    return fn();
  } finally {
    currentObserver = saved;
  }
}
