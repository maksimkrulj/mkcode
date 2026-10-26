import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import type { ModuleInterface } from "../src/analyzer/Analyzer.js";
import type * as AST from "../src/ast/nodes.js";
import { ROOT, analyze, errorCodes, errors } from "./helpers.js";

const SEND = "fn send(consume b: Buffer) {}\n";

function fn(program: AST.Program, name: string): AST.FunctionDeclaration {
  return program.body.find((s): s is AST.FunctionDeclaration => s.kind === "FunctionDeclaration" && s.name === name)!;
}

describe("Analyzer: ownership (consume)", () => {
  it("accepts the canonical example", () => {
    const result = analyze(readFileSync(path.join(ROOT, "example.mk"), "utf8"));
    assert.deepEqual(result.diagnostics.items.map((d) => d.code), ["MK3301"]); // schema-less model warning only
  });

  it("rejects use after consume, pointing at both places", () => {
    const [err] = errors(SEND + "fn main() {\n  let buf = Buffer.alloc(1)\n  send(consume buf)\n  print(buf)\n}");
    assert.equal(err?.code, "MK3001");
    assert.equal(err?.message, "use of consumed variable 'buf'");
    assert.deepEqual([err?.span.start.line, err?.span.start.column], [5, 9]);
    assert.deepEqual([err?.notes?.[0]?.span?.start.line, err?.notes?.[0]?.span?.start.column], [4, 8]);
  });

  it("rejects use in a nested scope after consume", () => {
    assert.deepEqual(errorCodes(SEND + "fn main() {\n  let b = Buffer.alloc(1)\n  send(consume b)\n  if true {\n    while true { print(b) }\n  }\n}"), ["MK3001"]);
  });

  it("rejects consuming the same variable twice in one call", () => {
    const src = "fn two(consume a: Buffer, consume b: Buffer) {}\nfn main() {\n  let x = Buffer.alloc(1)\n  two(consume x, consume x)\n}";
    assert.deepEqual(errorCodes(src), ["MK3001"]);
  });

  it("tracks consumption across branches", () => {
    const maybe = SEND + "fn main() {\n  let b = Buffer.alloc(1)\n  if now() > 0 { send(consume b) }\n  print(b)\n}";
    assert.deepEqual(errorCodes(maybe), ["MK3002"]);

    const both = SEND + "fn main() {\n  let b = Buffer.alloc(1)\n  if now() > 0 { send(consume b) } else { send(consume b) }\n  print(b)\n}";
    assert.deepEqual(errorCodes(both), ["MK3001"]);

    const returned = SEND + "fn main() {\n  let b = Buffer.alloc(1)\n  if now() > 0 {\n    send(consume b)\n    return\n  }\n  print(b)\n}";
    assert.deepEqual(errorCodes(returned), []);

    const shortCircuit = SEND + "fn ok(consume b: Buffer) -> bool { return true }\nfn main() {\n  let b = Buffer.alloc(1)\n  let r = now() > 0 && ok(consume b)\n  print(b)\n}";
    assert.deepEqual(errorCodes(shortCircuit), ["MK3002"]);
  });

  it("rejects consuming an outer variable inside a loop, but allows loop-local ones", () => {
    assert.deepEqual(errorCodes(SEND + "fn main() {\n  let b = Buffer.alloc(1)\n  for i in 0..3 { send(consume b) }\n}"), ["MK3009"]);
    assert.deepEqual(errorCodes(SEND + "fn main(items: List<Buffer>) {\n  for item in items { send(consume item) }\n}"), []);
  });

  it("requires ownership to consume a parameter", () => {
    assert.deepEqual(errorCodes(SEND + "fn borrow(b: Buffer) { send(consume b) }"), ["MK3008"]);
    assert.deepEqual(errorCodes(SEND + "fn own(consume b: Buffer) { send(consume b) }"), []);
  });

  it("requires explicit `consume` when passing a variable to a consuming parameter", () => {
    assert.deepEqual(errorCodes(SEND + "fn main() {\n  let b = Buffer.alloc(1)\n  send(b)\n}"), ["MK3010"]);
    // temporaries need no annotation
    assert.deepEqual(errorCodes(SEND + "fn main() { send(Buffer.alloc(1)) }"), []);
  });

  it("rejects consuming non-variables", () => {
    assert.deepEqual(errorCodes(SEND + "signal s = 1\nfn main() { send(consume s) }"), ["MK3004"]);
    assert.deepEqual(errorCodes(SEND + "fn main() { send(consume send) }"), ["MK3005"]);
    assert.deepEqual(errorCodes(SEND + "fn main() { send(consume Buffer.alloc(1)) }"), ["MK3003"]);
  });

  it("rejects consuming captured variables and consuming what a closure captured", () => {
    assert.deepEqual(errorCodes(SEND + "fn main() {\n  let b = Buffer.alloc(1)\n  let f = fn() => send(consume b)\n}"), ["MK3006"]);
    assert.deepEqual(errorCodes(SEND + "fn main() {\n  let b = Buffer.alloc(1)\n  let f = fn() => print(b)\n  send(consume b)\n}"), ["MK3007"]);
    // module-level variable consumed at top level but read by a function
    assert.deepEqual(errorCodes(SEND + "let b = Buffer.alloc(1)\nsend(consume b)\nfn later() { print(b) }"), ["MK3007"]);
  });

  it("lets a spawned task take ownership", () => {
    assert.deepEqual(errorCodes(SEND + "fn main() {\n  let b = Buffer.alloc(1)\n  let t = spawn send(consume b)\n}"), []);
    assert.deepEqual(errorCodes(SEND + "fn main() {\n  let b = Buffer.alloc(1)\n  let t = spawn send(consume b)\n  print(b)\n}"), ["MK3001"]);
  });

  it("revives a `var` when it is reassigned", () => {
    const src = SEND + "fn main() {\n  var b = Buffer.alloc(1)\n  send(consume b)\n  b = Buffer.alloc(2)\n  print(b)\n}";
    assert.deepEqual(errorCodes(src), []);
  });

  it("allows moving into a new binding", () => {
    assert.deepEqual(errorCodes("fn main() {\n  let a = Buffer.alloc(1)\n  let b = consume a\n  print(b)\n  print(a)\n}"), ["MK3001"]);
  });
});

describe("Analyzer: implicit async", () => {
  it("marks I/O functions and their callers async, transitively", () => {
    const { program, diagnostics } = analyze(
      "fn leaf() -> int { return query count User }\nfn mid() -> int { return leaf() + 1 }\nfn top() { print(mid()) }\nfn pure(x: int) -> int { return x * 2 }\nfn main() { top()\n print(pure(2)) }",
    );
    assert.ok(!diagnostics.hasErrors);
    for (const name of ["leaf", "mid", "top", "main"]) assert.equal(fn(program, name).isAsync, true, name);
    assert.equal(fn(program, "pure").isAsync, false);

    const calls = (fn(program, "main").body.body as AST.ExpressionStatement[]).map((s) => s.expression as AST.CallExpression);
    assert.equal(calls[0]!.await, true); // top()
    assert.equal(calls[1]!.await, undefined); // print(...) is sync
    assert.equal((calls[1]!.args[0] as AST.CallExpression).await, false); // pure(2)
  });

  it("handles recursion and calls before declaration", () => {
    const { program } = analyze("fn a(n: int) { if n > 0 { b(n - 1) } }\nfn b(n: int) { a(n)\n sleep(1) }");
    assert.equal(fn(program, "a").isAsync, true);
    assert.equal(fn(program, "b").isAsync, true);
  });

  it("treats async built-ins and foreign imports as I/O", () => {
    const { program } = analyze('import { get } from "https://example.com/http.js"\nfn f() { sleep(10) }\nfn g() { get("/") }\nfn h() { print(1) }');
    assert.equal(fn(program, "f").isAsync, true);
    assert.equal(fn(program, "g").isAsync, true);
    assert.equal(fn(program, "h").isAsync, false);
  });

  it("rejects I/O in parameter defaults, which JavaScript cannot await", () => {
    const load = "fn load() -> int { return query count User }\n";
    assert.deepEqual(errorCodes(load + "fn f(x: int = load()) {}"), ["MK3205"]);
    assert.deepEqual(errorCodes("fn f(x: int = len(\"ab\"), cb: any = fn() => query count User) {}"), []);
  });

  it("does not make the caller of `spawn` async", () => {
    const { program } = analyze("fn work() { sleep(1) }\nfn main() { let t = spawn work() }");
    assert.equal(fn(program, "main").isAsync, false);
  });

  it("uses imported MK module interfaces", () => {
    const iface: ModuleInterface = {
      exports: new Map([
        ["load", { kind: "function", isAsync: true, params: [], returns: { kind: "any" } }],
        ["add", { kind: "function", isAsync: false, params: [], returns: { kind: "int" } }],
        ["take", { kind: "function", isAsync: false, params: [{ name: "b", consume: true, optional: false, type: { kind: "any" } }], returns: { kind: "void" } }],
      ]),
    };
    const options = { resolveModule: () => iface };
    const { program } = analyze('import { load, add } from "./lib.mk"\nfn a() { load() }\nfn b() { add() }', options);
    assert.equal(fn(program, "a").isAsync, true);
    assert.equal(fn(program, "b").isAsync, false);
    assert.deepEqual(errorCodes('import { take } from "./lib.mk"\nfn main() {\n  let x = 1\n  take(x)\n}', options), ["MK3010"]);
    assert.deepEqual(errorCodes('import { missing } from "./lib.mk"', options), ["MK3501"]);
  });
});

describe("Analyzer: signals", () => {
  it("detects derived signals and protects them from assignment", () => {
    const { program } = analyze("signal a = 1\nsignal b = a * 2\nsignal c = 5");
    const [a, b, c] = program.body as AST.SignalDeclaration[];
    assert.deepEqual([a!.derived, b!.derived, c!.derived], [false, true, false]);
    assert.deepEqual(errorCodes("signal a = 1\nsignal b = a * 2\nfn main() {\n  a = 2\n  b = 3\n}"), ["MK3202"]);
  });

  it("rejects I/O inside derived signals", () => {
    assert.deepEqual(errorCodes("signal min = 1\nsignal n = query count User where score > min"), ["MK3204"]);
  });
});

describe("Analyzer: queries", () => {
  const MODEL = "model User {\n  id: int\n  name: string\n  score: int\n  email: string?\n}\n";

  it("classifies columns and host values with a schema", () => {
    const { program, diagnostics } = analyze(MODEL + "fn f(score: int, limit: int) -> List<User> { return query User where score > limit }");
    assert.ok(!diagnostics.hasErrors);
    const q = ((fn(program, "f").body.body[0] as AST.ReturnStatement).value as AST.QueryExpression).where as AST.BinaryExpression;
    assert.equal((q.left as AST.Identifier).queryRole, "column"); // the field shadows the parameter, like SQL
    assert.equal((q.right as AST.Identifier).queryRole, "host");
  });

  it("classifies by scope without a schema", () => {
    const { program } = analyze("signal score = 1\nfn f(min: int) { let r = query User where score >= min }");
    const q = ((fn(program, "f").body.body[0] as AST.VariableDeclaration).init as AST.QueryExpression).where as AST.BinaryExpression;
    assert.equal((q.left as AST.Identifier).queryRole, "column");
    assert.equal((q.right as AST.Identifier).queryRole, "host");
  });

  it("checks columns, types and inserts against the schema", () => {
    const [unknown] = errors(MODEL + "fn f() { let r = query User where scor > 1 order by nme }");
    assert.equal(unknown?.code, "MK3401"); // `scor` is neither a column nor a variable
    const order = errors(MODEL + "fn f() { let r = query User order by nme }");
    assert.equal(order[0]?.code, "MK3303");
    assert.match(order[0]!.message, /did you mean 'name'/);
    assert.deepEqual(errorCodes(MODEL + 'fn f() { let r = query User where score == "high" }'), ["MK3102"]);
    assert.deepEqual(errorCodes(MODEL + 'fn f() { let r = query User where score.startsWith("1") }'), ["MK3307"]);
    assert.deepEqual(errorCodes(MODEL + 'fn f() { insert User { name: "a" } }'), ["MK3304"]);
    assert.deepEqual(errorCodes(MODEL + 'fn f() { insert User { name: "a", score: 1, bogus: 2 } }'), ["MK3303"]);
    assert.deepEqual(errorCodes(MODEL + 'fn f() { insert User { name: "a", score: "x" } }'), ["MK3104"]);
  });

  it("types query results", () => {
    assert.deepEqual(errorCodes(MODEL + "fn f() -> int { return query count User }"), []);
    assert.deepEqual(errorCodes(MODEL + "fn f() -> List<User> { return query first User }"), ["MK3104"]);
    assert.deepEqual(errorCodes(MODEL + "fn f() -> string? { let u = query first User\n return u?.name }"), []);
  });
});

describe("Analyzer: names and types", () => {
  it("reports undefined names with suggestions", () => {
    const [err] = errors("fn main() {\n  let total = 1\n  print(totl)\n}");
    assert.equal(err?.code, "MK3401");
    assert.match(err!.message, /did you mean 'total'/);
  });

  it("enforces immutability and scoping", () => {
    assert.deepEqual(errorCodes("fn main() {\n  let a = 1\n  a = 2\n}"), ["MK3201"]);
    assert.deepEqual(errorCodes("fn main() {\n  var a = 1\n  a += 2\n}"), []);
    assert.deepEqual(errorCodes("fn main() {\n  let a = 1\n  let a = 2\n}"), ["MK3402"]);
    assert.deepEqual(errorCodes("fn main() {\n  if true { let inner = 1 }\n  print(inner)\n}"), ["MK3401"]);
    assert.deepEqual(errorCodes("break"), ["MK3404"]);
  });

  it("checks calls, returns and conditions", () => {
    const sig = "fn add(a: int, b: int = 1) -> int { return a + b }\n";
    assert.deepEqual(errorCodes(sig + "fn main() { add() }"), ["MK3114"]);
    assert.deepEqual(errorCodes(sig + "fn main() { add(1, 2, 3) }"), ["MK3114"]);
    assert.deepEqual(errorCodes(sig + 'fn main() { add("x") }'), ["MK3110"]);
    assert.deepEqual(errorCodes('fn f() -> int { return "x" }'), ["MK3104"]);
    assert.deepEqual(errorCodes("fn f(x: int) -> int { if x > 0 { return 1 } }"), ["MK3105"]);
    assert.deepEqual(errorCodes("fn f() { if 5 { print(1) } }"), ["MK3103"]);
    assert.deepEqual(errorCodes('let x: int = "nope"'), ["MK3104"]);
    assert.deepEqual(errorCodes('let x = true + 1'), ["MK3101"]);
    assert.deepEqual(errorCodes("let x = 1 + 2.5\nlet y: float = x"), []);
  });

  it("stays quiet about values from untyped code", () => {
    assert.deepEqual(errorCodes('import lib from "https://x.dev/lib.js"\nlet a: int = lib.compute()\nlet b = lib.name + 1'), []);
  });
});
