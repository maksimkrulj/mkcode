import { db, type Model } from "./db.js";
import { effect, signal, untrack } from "./signals.js";

/**
 * `signal x = live query ...` — a read-only signal holding the query's latest result.
 *
 * It re-runs when any signal read while building the query changes (those reads are tracked by
 * an effect), and whenever its table is written through `insert` / `update` / `delete`. Writes wait
 * for dependent live queries to refresh, so code right after an `insert` sees fresh data.
 */
export class LiveQuery<T> {
  /** Resolves once the first result has arrived. */
  readonly loaded: Promise<void>;
  private readonly state;
  private version = 0;
  private applied = 0;
  private readonly stopEffect: () => void;
  private readonly stopChanges: () => void;

  constructor(model: Model<any>, run: () => Promise<T>, initial: T) {
    this.state = signal<T>(initial);
    let markLoaded!: () => void;
    this.loaded = new Promise((resolve) => (markLoaded = resolve));
    let first = true;

    const refresh = (): Promise<void> => {
      const version = ++this.version;
      return run().then(
        (rows) => {
          // Results apply in order; one overtaken by a newer result is dropped. Unchanged rows don't wake effects.
          if (version > this.applied) {
            this.applied = version;
            if (JSON.stringify(rows) !== JSON.stringify(this.state.peek())) this.state.value = rows;
          }
          if (first) {
            first = false;
            markLoaded();
          }
        },
        (error) => console.error(error),
      );
    };

    this.stopEffect = effect(() => {
      void refresh();
    });
    this.stopChanges = db.onChange(model.name, () => untrack(refresh));
  }

  get value(): T {
    return this.state.value;
  }

  peek(): T {
    return this.state.peek();
  }

  dispose(): void {
    this.stopEffect();
    this.stopChanges();
  }

  toJSON(): T {
    return this.state.peek();
  }
}

export function live<T>(model: Model<any>, run: () => Promise<T>, initial: T): LiveQuery<T> {
  return new LiveQuery(model, run, initial);
}
