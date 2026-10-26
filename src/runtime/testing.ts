import { MemoryAdapter, db } from "./db.js";

interface TestCase {
  name: string;
  fn: () => unknown;
}

const tests: TestCase[] = [];

function env(name: string): string | undefined {
  return (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env[name];
}

export class AssertionError extends Error {
  constructor(
    message: string,
    readonly where: string,
    readonly details?: string,
  ) {
    super(message);
    this.name = "AssertionError";
  }
}

/** Registers a compiled `test "name" { ... }` block. */
export function test(name: string, fn: () => unknown): void {
  tests.push({ name, fn });
}

/** True when started by `mk test` (or by the playground's Test button). */
export function testing(): boolean {
  return env("MK_TEST") === "1" || (globalThis as { MK_TEST?: boolean }).MK_TEST === true;
}

/** Forgets registered tests (the playground runs many programs in one page). */
export function clearTests(): void {
  tests.length = 0;
}

export function assert(condition: unknown, text: string, where: string, message?: string): void {
  if (condition !== true) throw new AssertionError(message ?? `assertion failed: ${text}`, where);
}

export function assertEqual(left: unknown, right: unknown, text: string, where: string, message?: string): void {
  if (!deepEqual(left, right)) {
    throw new AssertionError(message ?? `assertion failed: ${text}`, where, `left:  ${show(left)}\nright: ${show(right)}`);
  }
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

function show(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

const color = (code: number) => (s: string) =>
  (globalThis as { process?: { stdout?: { isTTY?: boolean } } }).process?.stdout?.isTTY && !env("NO_COLOR") ? `\x1b[${code}m${s}\x1b[0m` : s;
const green = color(32);
const red = color(31);
const dim = color(2);

/** Runs every registered test, each against a fresh in-memory database. */
export async function runTests(): Promise<{ passed: number; failed: number }> {
  const filter = env("MK_TEST_FILTER");
  let passed = 0;
  let failed = 0;
  const started = Date.now();
  for (const t of tests) {
    if (filter && !t.name.includes(filter)) continue;
    db.use(new MemoryAdapter());
    const t0 = Date.now();
    try {
      const result = await t.fn();
      const r = result as { tag?: string; error?: unknown } | undefined;
      if (r?.tag === "Err") throw new Error(`the test returned Err(${show(r.error)})`);
      passed++;
      console.log(`  ${green("✓")} ${t.name} ${dim(`(${Date.now() - t0} ms)`)}`);
    } catch (e) {
      failed++;
      console.log(`  ${red("✗")} ${t.name}`);
      const err = e as AssertionError;
      console.log(red(`      ${err.message ?? String(e)}`));
      if (err.details) console.log(err.details.split("\n").map((l) => `        ${l}`).join("\n"));
      if (err.where) console.log(dim(`        at ${err.where}`));
    }
  }
  const summary = `\n${passed} passed, ${failed} failed ${dim(`(${Date.now() - started} ms)`)}`;
  console.log(failed ? red(summary) : green(summary));
  const proc = (globalThis as { process?: { exitCode?: number } }).process;
  if (failed && proc) proc.exitCode = 1;
  return { passed, failed };
}
