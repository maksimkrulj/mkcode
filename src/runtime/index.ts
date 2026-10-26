/**
 * The MK runtime. Compiled programs import it as `$mk`; it has no dependencies.
 */
export { Signal, Computed, signal, computed, effect, batch, untrack } from "./signals.js";
export { Ok, Err, isResult, type Result } from "./result.js";
export { map, filter, reduce, each, find, some, every, sortBy, sum, take } from "./collections.js";
export { h, mount, renderToString, isMarkup, VNode, type Markup, type Child } from "./markup.js";
export { live, LiveQuery } from "./live.js";
export { test, testing, runTests, clearTests, assert, assertEqual, deepEqual, AssertionError } from "./testing.js";
export * as http from "./http.js";
export { q, isExpr, evaluate, type Expr, type Dialect, type CompiledSQL, type Row } from "./query.js";
export {
  db,
  Database,
  QueryBuilder,
  MemoryAdapter,
  SqlAdapter,
  SqliteAdapter,
  createTableSQL,
  type MigrationPlan,
  selectSQL,
  countSQL,
  insertSQL,
  updateSQL,
  deleteSQL,
  type Adapter,
  type Model,
  type SqlDriver,
} from "./db.js";

// ---------------------------------------------------------------------------
// Built-in functions
// ---------------------------------------------------------------------------

export function len(value: unknown): number {
  if (typeof value === "string" || Array.isArray(value)) return value.length;
  if (value instanceof Map || value instanceof Set) return value.size;
  if (value instanceof Uint8Array) return value.byteLength;
  if (value && typeof value === "object") return Object.keys(value).length;
  throw new TypeError(`len() is not defined for ${value === null ? "null" : typeof value}`);
}

export function toInt(value: unknown): number {
  const n = typeof value === "string" ? Number.parseInt(value, 10) : Math.trunc(Number(value));
  if (Number.isNaN(n)) throw new TypeError(`int(): cannot convert ${JSON.stringify(value)} to an int`);
  return n;
}

export function range(start: number, end: number): number[] {
  const out: number[] = [];
  for (let i = start; i < end; i++) out.push(i);
  return out;
}

/** `item in container` */
export function contains(container: unknown, item: unknown): boolean {
  if (typeof container === "string") return container.includes(String(item));
  if (Array.isArray(container)) return container.includes(item);
  if (container instanceof Map || container instanceof Set) return container.has(item);
  if (container && typeof container === "object") return Object.prototype.hasOwnProperty.call(container, item as PropertyKey);
  return false;
}

export function isNull(value: unknown): boolean {
  return value === null || value === undefined;
}

export function panic(message = "panic"): never {
  throw new Error(message);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface FetchResult {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  /** The response body, already read. */
  text: string;
  json(): any;
}

/** HTTP request whose body is read eagerly, so callers never deal with streams or promises. */
export async function fetch(url: string, init?: RequestInit): Promise<FetchResult> {
  const res = await globalThis.fetch(url, init);
  const text = await res.text();
  return {
    status: res.status,
    ok: res.ok,
    headers: Object.fromEntries(res.headers),
    text,
    json: () => JSON.parse(text),
  };
}

export async function fetchText(url: string, init?: RequestInit): Promise<string> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`fetchText(${url}): HTTP ${res.status}`);
  return res.text;
}

export async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`fetchJson(${url}): HTTP ${res.status}`);
  return res.json();
}

export async function readFile(path: string): Promise<string> {
  const fs = await import("node:fs/promises");
  return fs.readFile(path, "utf8");
}

export async function writeFile(path: string, contents: string): Promise<void> {
  const fs = await import("node:fs/promises");
  await fs.writeFile(path, contents, "utf8");
}

/** `spawn` — start a task concurrently; the caller keeps going. */
export function spawn<T>(task: () => Promise<T>): Promise<T> {
  return Promise.resolve().then(task);
}

/** `join(task)` → its result; `join(a, b)` or `join([a, b])` → all results. */
export function join(...tasks: unknown[]): Promise<any> {
  if (tasks.length === 1) {
    const [only] = tasks;
    return Array.isArray(only) ? Promise.all(only) : Promise.resolve(only);
  }
  return Promise.all(tasks);
}
