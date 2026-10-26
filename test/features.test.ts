import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import type * as AST from "../src/ast/nodes.js";
import { Lexer } from "../src/lexer/Lexer.js";
import { TokenType as T, type MarkupTag } from "../src/lexer/Token.js";
import { Parser } from "../src/parser/Parser.js";
import { analyze, errorCodes, errors, parse, runMK, tempDir, toJS, toTS } from "./helpers.js";

const first = <K extends AST.Statement["kind"]>(src: string, kind: K) =>
  parse(src).body.find((s) => s.kind === kind) as Extract<AST.Statement, { kind: K }>;
const warnings = (src: string) => analyze(src).diagnostics.items.filter((d) => d.severity === "warning").map((d) => d.code);

const SHAPES = "enum Shape {\n  Circle(radius: float)\n  Rect(w: float, h: float)\n  Empty\n}\n";

describe("Lexer: markup and pipes", () => {
  it("scans markup as one token with attributes, holes and children", () => {
    const tokens = Lexer.tokenize('let v = <div class="a" on:click={n += 1}>Hi {name}<br/></div>').tokens;
    const markup = tokens.find((t) => t.type === T.Markup)!;
    const tree = markup.value as MarkupTag;
    assert.equal(tree.tag, "div");
    assert.deepEqual(tree.attributes.map((a) => [a.name, typeof a.value === "string" ? a.value : a.value === true ? true : a.value.source]), [
      ["class", "a"],
      ["on:click", "n += 1"],
    ]);
    assert.deepEqual(tree.children.map((c) => c.kind), ["text", "expr", "element"]);
  });

  it("keeps comparisons and generics out of markup", () => {
    assert.ok(Lexer.tokenize("let x = a < b").tokens.some((t) => t.type === T.Less));
    assert.ok(!Lexer.tokenize("fn f() -> List<int> {}").tokens.some((t) => t.type === T.Markup));
  });

  it("reports unclosed and mismatched tags", () => {
    assert.equal(Lexer.tokenize("let v = <div><p></div>").diagnostics.items[0]?.code, "MK1010");
    assert.match(Lexer.tokenize("let v = <ul>").diagnostics.items[0]!.message, /never closed/);
  });

  it("tokenizes |>", () => {
    assert.ok(Lexer.tokenize("xs |> map(f)").tokens.some((t) => t.type === T.Pipe));
  });
});

describe("Parser: new syntax", () => {
  it("parses enums, match arms, nested patterns and guards", () => {
    const e = first(SHAPES, "EnumDeclaration");
    assert.deepEqual(e.variants.map((v) => [v.name, v.fields.length]), [["Circle", 1], ["Rect", 2], ["Empty", 0]]);
    const m = (parse("let x = match r {\n  Ok(v) if v > 1 => v\n  Err(NotFound(id)) => 0\n  _ => -1\n}").body[0] as AST.VariableDeclaration).init as AST.MatchExpression;
    assert.equal(m.arms.length, 3);
    assert.ok(m.arms[0]!.guard);
    const nested = m.arms[1]!.pattern as AST.VariantPattern;
    assert.equal((nested.args[0] as AST.VariantPattern).name, "NotFound");
    assert.equal(m.arms[2]!.pattern.kind, "WildcardPattern");
  });

  it("desugars pipes into calls and parses ?", () => {
    const call = (first("let y = xs |> filter(ok) |> map(f)", "VariableDeclaration").init as AST.CallExpression);
    assert.equal((call.callee as AST.Identifier).name, "map");
    assert.equal(((call.args[0] as AST.CallExpression).callee as AST.Identifier).name, "filter");
    assert.equal(first("let u = load(1)?", "VariableDeclaration").init.kind, "TryExpression");
  });

  it("parses routes, tests, asserts, views and live queries", () => {
    const r = first('route GET "/users/:id" (id: int) -> User? {\n  return null\n}', "RouteDeclaration");
    assert.deepEqual([r.method, r.path, r.params[0]?.name], ["GET", "/users/:id", "id"]);
    const t = first('test "adds" {\n  assert 1 + 1 == 2\n}', "TestDeclaration");
    assert.equal(t.body.body[0]!.kind, "AssertStatement");
    const v = first("view Card(title: string) {\n  <h1>{title}</h1>\n}", "FunctionDeclaration");
    assert.equal(v.isView, true);
    const live = first("signal top = live query User where score > 1", "SignalDeclaration").init as AST.QueryExpression;
    assert.equal(live.live, true);
  });

  it("recovers from a stray closing brace without repeating errors", () => {
    const { diagnostics } = Parser.parse("fn a() {}\n}\nfn b() {}\n");
    assert.equal(diagnostics.items.length, 1);
  });
});

describe("Analyzer: enums, match and Result", () => {
  it("checks exhaustiveness, including nested patterns and guards", () => {
    const area = SHAPES + "fn area(s: Shape) -> float {\n  return match s {\n    Circle(r) => r\n    Rect(w, h) => w * h\n  }\n}";
    const [err] = errors(area);
    assert.equal(err?.code, "MK3703");
    assert.match(err!.message, /Empty/);
    const guarded = SHAPES + "fn f(s: Shape) -> int {\n  return match s {\n    Circle(r) if r > 1.0 => 1\n    Rect(_, _) => 2\n    Empty => 3\n  }\n}";
    assert.deepEqual(errorCodes(guarded), ["MK3703"]);
    const nested = "enum E { A, B(n: int) }\nfn f(r: Result<int, E>) -> int {\n  return match r {\n    Ok(v) => v\n    Err(A) => 0\n    Err(B(n)) => n\n  }\n}";
    assert.deepEqual(errorCodes(nested), []);
    assert.deepEqual(errorCodes("fn f(n: int) -> string {\n  return match n { 1 => \"one\" }\n}"), ["MK3703"]);
  });

  it("checks variants, field counts and types", () => {
    assert.deepEqual(errorCodes(SHAPES + "fn f(s: Shape) -> int {\n  return match s {\n    Square(x) => 1\n    _ => 0\n  }\n}"), ["MK3702"]);
    assert.deepEqual(errorCodes(SHAPES + "fn f(s: Shape) -> int {\n  return match s {\n    Rect(w) => 1\n    _ => 0\n  }\n}"), ["MK3707"]);
    assert.deepEqual(errorCodes(SHAPES + 'let c = Circle("big")'), ["MK3110"]);
    assert.deepEqual(errorCodes(SHAPES + "let r = Shape.Rectangle(1.0, 2.0)"), ["MK3702"]);
  });

  it("restricts ? to Results inside Result-returning functions", () => {
    const load = "fn load(id: int) -> Result<int, string> { return Ok(id) }\n";
    assert.deepEqual(errorCodes(load + "fn a() -> Result<int, string> {\n  let v = load(1)?\n  return Ok(v)\n}"), []);
    assert.deepEqual(errorCodes(load + "fn b() -> int {\n  let v = load(1)?\n  return v\n}"), ["MK3704"]);
    assert.deepEqual(errorCodes("fn c(x: int) -> Result<int, string> {\n  let v = x?\n  return Ok(v)\n}"), ["MK3708"]);
    assert.deepEqual(errorCodes(load + "fn d() -> Result<bool, string> {\n  let v = true && load(1)? > 0\n  return Ok(v)\n}"), ["MK3705"]);
  });

  it("narrows optionals after a null check", () => {
    const src = "model User { id: int, name: string }\nfn name(uid: int) -> string {\n  let u = query first User where id == uid\n  if u == null { return \"?\" }\n  return u.name\n}";
    assert.deepEqual(errorCodes(src), []);
    const unnarrowed = "model User { id: int, name: string }\nfn name(uid: int) -> string {\n  let u = query first User where id == uid\n  return u.name\n}";
    assert.deepEqual(errorCodes(unnarrowed), ["MK3104"]);
  });
});

describe("Analyzer: pipelines, views, live queries, routes", () => {
  it("makes higher-order calls async when their function does I/O, and infers lambda params", () => {
    const { program } = analyze("fn slow(x: int) -> int {\n  sleep(1)\n  return x\n}\nfn main() {\n  let ys = [1, 2] |> map(slow)\n  let zs = [1, 2] |> map(fn(x) => x + 1)\n}");
    const main = program.body.find((s): s is AST.FunctionDeclaration => s.kind === "FunctionDeclaration" && s.name === "main")!;
    const [ys, zs] = main.body.body as AST.VariableDeclaration[];
    assert.equal((ys!.init as AST.CallExpression).await, true);
    assert.equal((zs!.init as AST.CallExpression).await, undefined);
    assert.equal(main.isAsync, true);
    assert.deepEqual(errorCodes('let bad = [1, 2] |> map(fn(x) => x + "a" - 1)'), ["MK3101"]);
  });

  it("checks views, props, bindings and markup holes", () => {
    const card = "view Card(title: string, size: int = 1) {\n  <h1>{title}</h1>\n}\n";
    assert.deepEqual(errorCodes(card + "let a = <Card title=\"x\" />"), []);
    assert.deepEqual(errorCodes(card + "let a = <Card titel=\"x\" />"), ["MK4002", "MK4002"]);
    assert.deepEqual(errorCodes("let n = 1\nlet a = <input bind:value={n} />"), ["MK4003"]);
    assert.deepEqual(errorCodes("fn load() -> int {\n  sleep(1)\n  return 1\n}\nlet a = <p>{load()}</p>"), ["MK4001"]);
    assert.deepEqual(errorCodes("view Empty() {\n  let x = 1\n}"), ["MK4004"]);
  });

  it("only allows live queries as signal initializers; views don't block on them", () => {
    assert.deepEqual(errorCodes("let x = live query User"), ["MK3801"]);
    const top = analyze("signal a = live query User").program.body[0] as AST.SignalDeclaration;
    assert.equal((top.init as AST.QueryExpression).liveAwait, true);
    const view = analyze("view V() {\n  signal a = live query User\n  <p>{len(a)}</p>\n}").program.body[0] as AST.FunctionDeclaration;
    assert.equal(((view.body.body[0] as AST.SignalDeclaration).init as AST.QueryExpression).liveAwait, false);
  });

  it("checks route parameters and duplicates", () => {
    assert.deepEqual(errorCodes('route GET "/u/:id" () { }'), ["MK3901"]);
    assert.deepEqual(errorCodes('route GET "/a" { }\nroute GET "/a" { }'), ["MK3902"]);
  });

  it("warns when a query compares a column with itself", () => {
    const src = "model T { id: int }\nfn f(id: int) -> int { return query count T where id == id }";
    assert.deepEqual(warnings(src), ["MK3308"]);
    assert.deepEqual(warnings("model T { id: int }\nfn f(tid: int) -> int { return query count T where id == tid }"), []);
  });
});

describe("CodeGenerator: lowering", () => {
  it("lowers match to an if chain over the tag", () => {
    const ts = toTS(SHAPES + "fn area(s: Shape) -> float {\n  return match s {\n    Circle(r) => r * r\n    Rect(w, h) => w * h\n    Empty => 0.0\n  }\n}");
    assert.match(ts, /^export|^type Shape =$/m);
    assert.match(ts, /const Circle = \(radius: number\): Shape => \(\{ tag: "Circle", radius \}\);/);
    assert.match(ts, /const Empty: Shape = \{ tag: "Empty" \};/);
    assert.match(ts, /if \(s\.tag === "Circle"\) \{\n\s+const r = s\.radius;\n\s+return r \* r;\n\s+\} else if \(s\.tag === "Rect"\) \{/);
    assert.match(ts, /\} else \{\n\s+return 0\.0;\n\s+\}/);
  });

  it("lowers ? to an early return", () => {
    const ts = toTS("fn load(id: int) -> Result<int, string> { return Ok(id) }\nfn twice(id: int) -> Result<int, string> {\n  let v = load(id)?\n  return Ok(v * 2)\n}");
    assert.match(ts, /const \$r\d+ = load\(id\);\n\s+if \(\$r\d+\.tag === "Err"\) return \$mk\.Err\(\$r\d+\.error\);\n\s+const v = \$r\d+\.value;/);
  });

  it("emits routes, tests, views and live queries", () => {
    const ts = toTS(
      'model T { id: int, title: string }\nroute GET "/t/:tid" (tid: int) -> T? {\n  return query first T where id == tid\n}\n' +
        'test "works" {\n  assert 1 == 1\n}\nsignal all = live query T\nview Title(text: string) {\n  <h1 class="t">{text}</h1>\n}',
    );
    assert.match(ts, /\$mk\.http\.route\("GET", "\/t\/:tid", \{ tid: "int" \}, async \(\{ tid \}: \{ tid: number \}\) => \{/);
    assert.match(ts, /\$mk\.test\("works", async \(\) => \{\n\s+\$mk\.assertEqual\(1, 1, "1 == 1", "test\.mk:6"\);/);
    assert.match(ts, /const all = \$mk\.live\(T, \(\) => \$mk\.db\.from\(T\)\.all\(\), \[\]\);\nawait all\.loaded;/);
    assert.match(ts, /function Title\(\{ text \}: \{ text: string \}\): \$mk\.Markup \{\n\s+return \$mk\.h\("h1", \{ class: "t" \}, \[\(\) => text\]\);/);
    assert.match(ts, /if \(\$mk\.testing\(\)\) \{\n\s+await \$mk\.runTests\(\);\n\} else \{\n\s+await \$mk\.http\.autoServe\(\);/);
  });
});

describe("New features run end to end", () => {
  it("matches enums and propagates errors", () => {
    const out = runMK(
      SHAPES +
        "fn area(s: Shape) -> float {\n  return match s {\n    Circle(r) => 3.0 * r * r\n    Rect(w, h) if w == h => w * w\n    Rect(w, h) => w * h\n    Empty => 0.0\n  }\n}\n" +
        "fn half(n: int) -> Result<int, string> {\n  if n % 2 == 1 { return Err(\"odd\") }\n  return Ok(int(n / 2))\n}\n" +
        "fn quarter(n: int) -> Result<int, string> {\n  let h = half(n)?\n  return half(h)\n}\n" +
        'fn main() {\n  print([Circle(1.0), Rect(2.0, 2.0), Rect(2.0, 3.0), Empty] |> map(area))\n  for n in [8, 6, 3] {\n    match quarter(n) {\n      Ok(q) => print("ok", q)\n      Err(e) => print("err", e)\n    }\n  }\n}',
    );
    assert.equal(out, "[ 3, 4, 6, 0 ]\nok 2\nerr odd\nerr odd\n");
  });

  it("runs I/O inside map concurrently", () => {
    const out = runMK("fn slow(x: int) -> int {\n  sleep(150)\n  return x * 10\n}\nfn main() {\n  let t = now()\n  let ys = [1, 2, 3, 4] |> map(slow)\n  print(ys, now() - t < 400)\n}");
    assert.equal(out, "[ 10, 20, 30, 40 ] true\n");
  });

  it("keeps live queries in sync with writes and signals", () => {
    const out = runMK(
      "model P { id: int, name: string, score: int }\nsignal min = 50\nsignal top = live query P where score >= min order by score desc\n" +
        'effect { print(top |> map(fn(p) => p.name)) }\nfn main() {\n  insert P { name: "a", score: 90 }\n  insert P { name: "b", score: 10 }\n  min = 0\n  sleep(20)\n  delete P where name == "a"\n}',
    );
    assert.equal(out, "[]\n[ 'a' ]\n[ 'a', 'b' ]\n[ 'b' ]\n");
  });

  it("serves routes in-process and renders views to HTML", () => {
    const out = runMK(
      'model T { id: int, title: string }\nroute POST "/t" (title: string) -> T { return insert T { title } }\nroute GET "/t/:tid" (tid: int) -> T? { return query first T where id == tid }\n' +
        'view Page(n: int) {\n  <p class="n">{n} &amp; <b>more</b></p>\n}\nroute GET "/" -> Markup { return <Page n={2} /> }\n' +
        'fn main() {\n  print(request("POST", "/t", { title: "x" }).body)\n  print(request("GET", "/t/1").status, request("GET", "/t/9").status, request("GET", "/t/z").status, request("PUT", "/t/1").status)\n  print(request("GET", "/").text)\n}',
    );
    assert.equal(out, "{ id: 1, title: 'x' }\n200 404 400 405\n<!doctype html><p class=\"n\">2 &amp; <b>more</b></p>\n");
  });

  it("runs test blocks under MK_TEST with readable failures", () => {
    const src = 'fn double(x: int) -> int { return x * 2 }\ntest "doubles" {\n  assert double(2) == 4\n}\ntest "fails" {\n  assert double(2) == 5\n}\nfn main() { print("main ran") }';
    assert.equal(runMK(src), "main ran\n");
    let out = "";
    try {
      runMK(src, { MK_TEST: "1", NO_COLOR: "1" });
    } catch (e) {
      out = (e as { stdout: string }).stdout;
    }
    assert.match(out, /✓ doubles/);
    assert.match(out, /✗ fails\n\s+assertion failed: double\(2\) == 5\n\s+left: {2}4\n\s+right: 5\n\s+at test\.mk:6/);
    assert.match(out, /1 passed, 1 failed/);
  });
});

describe("Runtime: collections, http, markup, migrations", async () => {
  const rt = await import("../src/runtime/index.js");

  it("collection functions handle sync and async callbacks", async () => {
    assert.deepEqual(rt.map([1, 2], (x) => x * 2), [2, 4]);
    assert.deepEqual(await rt.map([1, 2], async (x) => x * 3), [3, 6]);
    assert.deepEqual(await rt.filter([1, 2, 3], async (x) => x !== 2), [1, 3]);
    const order: number[] = [];
    const total = await rt.reduce([1, 2, 3], 0, async (acc, x) => {
      order.push(x);
      return acc + x;
    });
    assert.equal(total, 6);
    assert.deepEqual(order, [1, 2, 3]);
    assert.equal(rt.find([1, 5, 9], (x) => x > 3), 5);
    assert.equal(await rt.some([1, 2], async (x) => x === 2), true);
    assert.equal(rt.every([1, 2], (x) => x > 1), false);
    assert.deepEqual(rt.sortBy(["ccc", "a", "bb"], (s) => s.length), ["a", "bb", "ccc"]);
    assert.equal(rt.sum([1, 2, 3.5]), 6.5);
  });

  it("renders markup safely without a DOM", () => {
    const html = rt.renderToString(rt.h("p", { title: '"x"', "on:click": () => 1, hidden: false }, ["<b>", rt.h("br", {}, []), () => 42]));
    assert.equal(html, '<p title="&quot;x&quot;">&lt;b&gt;<br>42</p>');
  });

  it("migrates SQLite schemas from models", async () => {
    const file = path.join(tempDir(), "m.sqlite");
    const db = await rt.SqliteAdapter.open(file);
    const v1 = { name: "Todo", fields: { id: "int", title: "string" } };
    assert.deepEqual(db.migrate([v1]).statements, ['CREATE TABLE "Todo" ("id" INTEGER PRIMARY KEY, "title" TEXT NOT NULL)']);
    const v2 = { name: "Todo", fields: { id: "int", done: "bool", note: "string?" } };
    const plan = db.migrate([v2]);
    assert.deepEqual(plan.statements, [
      'ALTER TABLE "Todo" ADD COLUMN "done" INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE "Todo" ADD COLUMN "note" TEXT',
    ]);
    assert.match(plan.warnings[0]!, /Todo\.title is no longer in the model/);
    assert.deepEqual(db.migrate([v2], { allowDrop: true }).statements, ['ALTER TABLE "Todo" DROP COLUMN "title"']);
    assert.deepEqual(db.migrate([v2]).statements, []);
    db.close();
  });
});

describe("JavaScript output of new features has no type syntax", () => {
  it("strips types from enums, routes and views", () => {
    const js = toJS(SHAPES + 'route GET "/" (n: int = 1) -> int { return n }\nview V(a: int) {\n  <p>{a}</p>\n}');
    assert.doesNotMatch(js, /: number|: Shape|\$mk\.Markup|as const|^type /m);
    assert.match(js, /const Circle = \(radius\) => \(\{ tag: "Circle", radius \}\);/);
  });
});
