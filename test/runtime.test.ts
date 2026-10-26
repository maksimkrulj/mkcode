import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import {
  Database,
  MemoryAdapter,
  SqliteAdapter,
  batch,
  computed,
  effect,
  join,
  len,
  q,
  signal,
  spawn,
  untrack,
  type Adapter,
} from "../src/runtime/index.js";
import { tempDir } from "./helpers.js";

describe("Runtime: signals", () => {
  it("computes lazily and caches until a dependency changes", () => {
    const a = signal(2);
    let runs = 0;
    const sq = computed(() => {
      runs++;
      return a.value * a.value;
    });
    assert.equal(runs, 0);
    assert.equal(sq.value, 4);
    assert.equal(sq.value, 4);
    assert.equal(runs, 1);
    a.value = 3;
    assert.equal(sq.value, 9);
    assert.equal(runs, 2);
  });

  it("re-runs effects, batches writes and supports dispose", () => {
    const a = signal(1);
    const b = signal(10);
    const sum = computed(() => a.value + b.value);
    const seen: number[] = [];
    const dispose = effect(() => seen.push(sum.value));
    a.value = 2;
    batch(() => {
      a.value = 3;
      b.value = 20;
    });
    dispose();
    a.value = 100;
    assert.deepEqual(seen, [11, 12, 23]);
  });

  it("tracks dependencies dynamically and honours untrack", () => {
    const flag = signal(true);
    const x = signal("x");
    const y = signal("y");
    const log: string[] = [];
    effect(() => log.push(flag.value ? x.value : untrack(() => y.value)));
    y.value = "y2"; // untracked: no re-run
    x.value = "x2";
    flag.value = false;
    x.value = "x3"; // no longer a dependency
    assert.deepEqual(log, ["x", "x2", "y2"]);
  });

  it("detects runaway effect cycles", () => {
    const n = signal(0);
    assert.throws(() => effect(() => (n.value = n.value + 1)), /cycle/);
  });
});

describe("Runtime: SQL compilation", () => {
  const db = new Database();
  const User = db.model<{ id: number; name: string; score: number; email: string | null }>("User", {
    id: "int",
    name: "string",
    score: "int",
    email: "string?",
  });

  it("produces parameterized SQL — values never reach the SQL text", () => {
    const sql = db
      .from(User)
      .where(q.and(q.gte(q.col("score"), 50), q.eq(q.col("name"), "x'; DROP TABLE User; --")))
      .orderBy("score", "desc")
      .limit(10)
      .toSQL();
    assert.equal(sql.sql, `SELECT * FROM "User" WHERE ("score" >= ?) AND ("name" = ?) ORDER BY "score" DESC LIMIT ?`);
    assert.deepEqual(sql.params, [50, "x'; DROP TABLE User; --", 10]);
  });

  it("supports dialects, NULL checks, IN lists, matching and projections", () => {
    const pg = db
      .from(User)
      .where(q.or(q.eq(q.col("email"), null), q.in(q.col("name"), ["a", "b"])))
      .offset(5)
      .select("name")
      .toSQL("postgres");
    assert.equal(pg.sql, `SELECT "name" FROM "User" WHERE "email" IS NULL OR "name" IN ($1, $2) OFFSET $3`);

    const lite = db.from(User).where(q.startsWith(q.col("name"), "A*")).offset(2).toSQL("sqlite");
    assert.equal(lite.sql, `SELECT * FROM "User" WHERE "name" GLOB ? LIMIT -1 OFFSET ?`);
    assert.deepEqual(lite.params, ["A[*]*", 2]);

    assert.equal(db.from(User).where(q.in(q.col("id"), [])).toSQL().sql, `SELECT * FROM "User" WHERE 1 = 0`);
  });
});

/** The same scenario must give identical results on every adapter. */
async function scenario(adapter: Adapter) {
  const db = new Database();
  db.use(adapter);
  const User = db.model<{ id: number; name: string; score: number; active: boolean; email: string | null }>("User", {
    id: "int",
    name: "string",
    score: "int",
    active: "bool",
    email: "string?",
  });
  for (const [name, score, active, email] of [
    ["Ana", 92, true, null],
    ["Marko", 47, true, "m@x.io"],
    ["Jelena", 78, false, null],
    ["Stefan", 65, true, "s@x.io"],
    ["Ana-Marija", 50, true, null],
  ] as const) {
    await db.insert(User, { name, score, active, email });
  }
  const names = (rows: { name: string }[]) => rows.map((r) => r.name);
  const result = {
    top: names(await db.from(User).where(q.gte(q.col("score"), 50)).orderBy("score", "desc").limit(3).all()),
    page: names(await db.from(User).orderBy("name").offset(1).limit(2).all()),
    noEmail: await db.from(User).where(q.eq(q.col("email"), null)).count(),
    activeNoEmail: await db.from(User).where(q.and(q.eq(q.col("active"), true), q.ne(q.col("email"), null))).count(),
    // NULL is neither equal nor unequal to a value (SQL three-valued logic)
    notMail: await db.from(User).where(q.ne(q.col("email"), "m@x.io")).count(),
    prefix: names(await db.from(User).where(q.startsWith(q.col("name"), "Ana")).orderBy("id").all()),
    caseSensitive: await db.from(User).where(q.contains(q.col("name"), "ana")).count(),
    first: await db.from(User).where(q.lt(q.col("score"), 0)).first(),
    bumped: await db.from(User).where(q.eq(q.col("active"), true)).update({ score: q.add(q.col("score"), 1) }),
    afterBump: (await db.from(User).where(q.eq(q.col("name"), "Ana")).first())?.score,
    activeFlag: (await db.from(User).where(q.eq(q.col("name"), "Jelena")).first())?.active,
    deleted: await db.from(User).where(q.not(q.eq(q.col("active"), true))).delete(),
    remaining: await db.from(User).count(),
    projected: await db.from(User).where(q.eq(q.col("id"), 4)).select("name", "score").all(),
  };
  await db.close();
  return result;
}

describe("Runtime: database adapters", () => {
  const expected = {
    top: ["Ana", "Jelena", "Stefan"],
    page: ["Ana-Marija", "Jelena"],
    noEmail: 3,
    activeNoEmail: 2,
    notMail: 1,
    prefix: ["Ana", "Ana-Marija"],
    caseSensitive: 0,
    first: null,
    bumped: 4,
    afterBump: 93,
    activeFlag: false,
    deleted: 1,
    remaining: 4,
    projected: [{ name: "Stefan", score: 66 }],
  };

  it("memory adapter follows SQL semantics", async () => {
    assert.deepEqual(await scenario(new MemoryAdapter()), expected);
  });

  it("SQLite adapter (node:sqlite) matches the memory adapter", async () => {
    const file = path.join(tempDir(), "test.sqlite");
    assert.deepEqual(await scenario(await SqliteAdapter.open(file)), expected);
  });
});

describe("Runtime: built-ins", () => {
  it("len, spawn and join", async () => {
    assert.equal(len("héllo"), 5);
    assert.equal(len(new Map([[1, 2]])), 1);
    assert.equal(len({ a: 1, b: 2 }), 2);
    const order: string[] = [];
    const task = spawn(async () => {
      order.push("task");
      return 42;
    });
    order.push("caller");
    assert.equal(await join(task), 42);
    assert.deepEqual(await join(spawn(async () => 1), spawn(async () => 2)), [1, 2]);
    assert.deepEqual(order, ["caller", "task"]);
  });
});
