import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { ROOT, runMK, toJS, toTS } from "./helpers.js";

const example = readFileSync(path.join(ROOT, "example.mk"), "utf8");

describe("CodeGenerator: example.mk", () => {
  const ts = toTS(example, { file: "example.mk" });

  it("emits signal primitives, deriving computed signals", () => {
    assert.match(ts, /^const score = \$mk\.signal\(100\);$/m);
    assert.match(ts, /^const doubleScore = \$mk\.computed\(\(\) => score\.value \* 2\);$/m);
  });

  it("makes only I/O functions async and awaits only their calls", () => {
    assert.match(ts, /^async function getActiveUsers\(minScore: number\): Promise<User\[\]> \{$/m);
    assert.match(ts, /^function processData\(payload: Buffer\) \{$/m);
    assert.match(ts, /^async function main\(\) \{$/m);
    assert.match(ts, /^ {2}processData\(buf\);$/m);
    assert.match(ts, /^ {2}const topUsers = await getActiveUsers\(50\);$/m);
    assert.match(ts, /^await main\(\);$/m);
    assert.doesNotMatch(ts, /await processData/);
  });

  it("compiles the query to a parameterized builder chain", () => {
    assert.match(ts, /\.from\(User\)/);
    assert.match(ts, /\.where\(\$mk\.q\.gte\(\$mk\.q\.col\("score"\), minScore\)\)/);
    assert.match(ts, /\.orderBy\("score", "desc"\)/);
    assert.match(ts, /\.all\(\);/);
    assert.match(ts, /^interface User \{ \[column: string\]: any \}$/m);
  });

  it("erases `consume` and preserves comments", () => {
    assert.doesNotMatch(ts, /consume/);
    assert.match(ts, /^\/\/ Linear Ownership$/m);
    assert.match(ts, /^ {2}\/\/ Fetching users implicitly without async\/await keywords$/m);
  });

  it("emits the same program without types for the JS target", () => {
    const js = toJS(example);
    assert.doesNotMatch(js, /interface |: number|Promise<|<User>/);
    assert.match(js, /async function getActiveUsers\(minScore\) \{/);
  });
});

describe("CodeGenerator: expressions", () => {
  it("reads and writes signals through .value", () => {
    const ts = toTS("signal n = 1\nfn bump() {\n  n += 1\n  n = n * 2\n  print(n)\n}");
    assert.match(ts, /n\.value \+= 1;/);
    assert.match(ts, /n\.value = n\.value \* 2;/);
    assert.match(ts, /console\.log\(n\.value\);/);
  });

  it("emits effects, templates, ranges and lambdas", () => {
    const ts = toTS('signal name = "MK"\neffect {\n  print("hi ${name} `x` \\${y}")\n}\nlet sq = fn(x: int) -> int => x * x\nfor i in 0..len("abc") { print(sq(i)) }');
    assert.match(ts, /\$mk\.effect\(\(\) => \{/);
    assert.match(ts, /`hi \$\{name\.value\} \\`x\\` \\\$\{y\}`/);
    assert.match(ts, /const sq = \(x: number\): number => x \* x;/);
    assert.match(ts, /for \(let i = 0; i < \$mk\.len\("abc"\); i\+\+\) \{/);
  });

  it("parenthesizes by precedence and keeps JS-specific rules", () => {
    const ts = toTS("let a = (1 + 2) * 3\nlet b = (true || false) ?? false\nlet c = a == null\nlet d = -(a - 1)\nlet e = 1 in [1, 2]");
    assert.match(ts, /const a = \(1 \+ 2\) \* 3;/);
    assert.match(ts, /const b = \(true \|\| false\) \?\? false;/);
    assert.match(ts, /const c = a == null;/);
    assert.match(ts, /const d = -\(a - 1\);/);
    assert.match(ts, /const e = \$mk\.contains\(\[1, 2\], 1\);/);
  });

  it("wraps awaited calls used as objects", () => {
    const ts = toTS("fn load() -> any { return query first Item }\nfn main() { print(load().name) }");
    assert.match(ts, /console\.log\(\(await load\(\)\)\.name\);/);
  });

  it("mangles JavaScript reserved words and constructs host classes", () => {
    const ts = toTS("let class = 1\nlet new = class + 1\nlet m = Map()\nm.set(\"k\", new)");
    assert.match(ts, /const class_ = 1;/);
    assert.match(ts, /const new_ = class_ \+ 1;/);
    assert.match(ts, /const m = new Map\(\);/);
  });

  it("compiles spawn/join and every database statement", () => {
    const ts = toTS(
      "model T {\n  id: int\n  name: string\n  n: int\n}\n" +
        'fn f(min: int, tags: List<string>) {\n  insert T { name: "x", n: min }\n' +
        "  let a = query first T where !(n < min) && name in tags\n" +
        '  let b = query count T where name.contains("y") || n == null\n' +
        "  let c = query T order by n limit 2 offset 1 select name\n" +
        "  let d = update T set n = n * 2 where id == 1\n" +
        "  let e = delete T where n >= min + 1\n" +
        "  let t = spawn query count T\n  print(join(t))\n}",
    );
    assert.match(ts, /^interface T \{$/m);
    assert.match(ts, /^const T = \$mk\.db\.model<T>\("T", \{ id: "int", name: "string", n: "int" \}\);$/m);
    assert.match(ts, /await \$mk\.db\.insert\(T, \{ name: "x", n: min \}\);/);
    assert.match(ts, /\$mk\.q\.and\(\$mk\.q\.not\(\$mk\.q\.lt\(\$mk\.q\.col\("n"\), min\)\), \$mk\.q\.in\(\$mk\.q\.col\("name"\), tags\)\)/);
    assert.match(ts, /\.first\(\)/);
    assert.match(ts, /\$mk\.q\.or\(\$mk\.q\.contains\(\$mk\.q\.col\("name"\), "y"\), \$mk\.q\.eq\(\$mk\.q\.col\("n"\), null\)\)/);
    assert.match(ts, /\.orderBy\("n", "asc"\)\.limit\(2\)\.offset\(1\)\.select\("name"\)\.all\(\)/);
    assert.match(ts, /\.update\(\{ n: \$mk\.q\.mul\(\$mk\.q\.col\("n"\), 2\) \}\)/);
    assert.match(ts, /\$mk\.q\.gte\(\$mk\.q\.col\("n"\), min \+ 1\)\)\.delete\(\)/);
    assert.match(ts, /const t = \$mk\.spawn\(async \(\) => await \$mk\.db\.from\(T\)\.count\(\)\);/);
    assert.match(ts, /console\.log\(await \$mk\.join\(t\)\);/);
  });

  it("omits the runtime import when nothing needs it", () => {
    const ts = toTS("fn add(a: int, b: int) -> int { return a + b }\nprint(add(1, 2))");
    assert.doesNotMatch(ts, /import \* as \$mk/);
  });
});

describe("Generated programs run", () => {
  it("runs example.mk against seeded data", () => {
    const seed = path.join(ROOT, "examples", "users.seed.json");
    const out = runMK(example, { MK_SEED: seed });
    assert.match(out, /^Processing buffer\.\.\.$/m);
    const names = [...out.matchAll(/name: '(\w+)'/g)].map((m) => m[1]);
    assert.deepEqual(names, ["Ana", "Jelena", "Stefan", "Mila"]); // score >= 50, highest first
  });

  it("re-runs effects when signals change", () => {
    const out = runMK("signal count = 1\nsignal doubled = count * 2\neffect { print(\"doubled\", doubled) }\ncount = 5\ncount = 5\ncount += 1");
    assert.equal(out, "doubled 2\ndoubled 10\ndoubled 12\n");
  });

  it("awaits implicit I/O in order", () => {
    const out = runMK(
      'fn slow(label: string) -> string {\n  sleep(20)\n  return label\n}\n' +
        'fn main() {\n  let t = spawn slow("task")\n  print(slow("first"))\n  print(join(t))\n  print("done")\n}',
    );
    assert.equal(out, "first\ntask\ndone\n");
  });

  it("runs database statements end to end", () => {
    const out = runMK(
      "model Item {\n  id: int\n  name: string\n  qty: int\n  note: string?\n}\n" +
        'fn main() {\n  insert Item { name: "apple", qty: 3 }\n  insert Item { name: "pear", qty: 0, note: "sold out" }\n  insert Item { name: "plum", qty: 7 }\n' +
        "  print(query count Item where qty > 0)\n" +
        "  print(update Item set qty = qty + 10 where note == null)\n" +
        '  print(query Item where qty >= 13 order by qty desc select name)\n' +
        '  print(delete Item where name.startsWith("p"))\n' +
        "  print(query first Item)\n}",
    );
    assert.equal(
      out,
      "2\n2\n[ { name: 'plum' }, { name: 'apple' } ]\n2\n{ id: 1, name: 'apple', qty: 13, note: null }\n",
    );
  });
});
