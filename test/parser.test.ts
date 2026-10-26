import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import type * as AST from "../src/ast/nodes.js";
import { Parser } from "../src/parser/Parser.js";
import { ROOT, parse } from "./helpers.js";

const expr = (src: string): AST.Expression => (parse(src).body[0] as AST.ExpressionStatement).expression;

/** Compact s-expression rendering, for precedence assertions. */
function sexp(e: AST.Expression): string {
  switch (e.kind) {
    case "BinaryExpression":
      return `(${e.operator} ${sexp(e.left)} ${sexp(e.right)})`;
    case "UnaryExpression":
      return `(${e.operator} ${sexp(e.operand)})`;
    case "AssignmentExpression":
      return `(${e.operator} ${sexp(e.target)} ${sexp(e.value)})`;
    case "CallExpression":
      return `(call ${sexp(e.callee)}${e.args.map((a) => " " + sexp(a)).join("")})`;
    case "MemberExpression":
      return `(. ${sexp(e.object)} ${e.property})`;
    case "Identifier":
      return e.name;
    case "NumberLiteral":
      return e.raw;
    case "RangeExpression":
      return `(.. ${sexp(e.start)} ${sexp(e.end)})`;
    case "ConsumeExpression":
      return `(consume ${sexp(e.argument)})`;
    default:
      return e.kind;
  }
}

describe("Parser", () => {
  it("parses the canonical example.mk", () => {
    const program = parse(readFileSync(path.join(ROOT, "example.mk"), "utf8"));
    assert.deepEqual(program.body.map((s) => s.kind), [
      "SignalDeclaration",
      "SignalDeclaration",
      "FunctionDeclaration",
      "FunctionDeclaration",
      "FunctionDeclaration",
    ]);
    const [, , getActive, process, main] = program.body as [unknown, unknown, AST.FunctionDeclaration, AST.FunctionDeclaration, AST.FunctionDeclaration];
    assert.equal(getActive.returnType?.kind === "TypeReference" && getActive.returnType.name, "List");
    assert.equal(process.params[0]!.consume, true);
    assert.equal(process.params[0]!.name, "payload");

    const call = (main.body.body[1] as AST.ExpressionStatement).expression as AST.CallExpression;
    assert.equal(call.args[0]!.kind, "ConsumeExpression");
  });

  it("parses query clauses", () => {
    const q = expr("query User where score >= minScore order by score desc, name limit 10 offset 5") as AST.QueryExpression;
    assert.equal(q.kind, "QueryExpression");
    assert.equal(q.model.name, "User");
    assert.equal(sexp(q.where!), "(>= score minScore)");
    assert.deepEqual(q.orderBy.map((o) => [o.column, o.direction]), [["score", "desc"], ["name", "asc"]]);
    assert.equal(sexp(q.limit!), "10");
    assert.equal(sexp(q.offset!), "5");
  });

  it("lets query clauses continue on following lines", () => {
    const decl = parse("let top = query User\n  where active\n  order by score desc\n  limit 3\nprint(top)").body;
    assert.equal(decl.length, 2);
    const q = (decl[0] as AST.VariableDeclaration).init as AST.QueryExpression;
    assert.equal(q.orderBy.length, 1);
    assert.ok(q.limit);
  });

  it("parses query modes and projections", () => {
    const count = expr("query count User where x") as AST.QueryExpression;
    assert.equal(count.mode, "count");
    const first = expr("query first User select name, score") as AST.QueryExpression;
    assert.equal(first.mode, "first");
    assert.deepEqual(first.select!.map((c) => c.name), ["name", "score"]);
  });

  it("parses insert / update / delete", () => {
    const ins = expr('insert User { name: "Ana", score }') as AST.InsertExpression;
    assert.equal(ins.kind, "InsertExpression");
    assert.deepEqual(ins.value.properties.map((p) => [p.key, p.shorthand]), [["name", false], ["score", true]]);

    const up = expr("update User set score = score + 1, rank = 2 where id == 3") as AST.UpdateExpression;
    assert.deepEqual(up.assignments.map((a) => [a.column, sexp(a.value)]), [["score", "(+ score 1)"], ["rank", "2"]]);
    assert.equal(sexp(up.where!), "(== id 3)");

    const del = expr("delete User where banned") as AST.DeleteExpression;
    assert.equal(del.kind, "DeleteExpression");
    // `delete` is still an ordinary name elsewhere
    assert.equal(expr("delete(x)").kind, "CallExpression");
  });

  it("respects operator precedence and associativity", () => {
    assert.equal(sexp(expr("1 + 2 * 3 == 7 && !done || x ?? y")), "(?? (|| (&& (== (+ 1 (* 2 3)) 7) (! done)) x) y)");
    assert.equal(sexp(expr("a - b - c")), "(- (- a b) c)");
    assert.equal(sexp(expr("a = b = 1")), "(= a (= b 1))");
    assert.equal(sexp(expr("-a.b(c).d")), "(- (. (call (. a b) c) d))");
    assert.equal(sexp(expr("0..n + 1")), "(.. 0 (+ n 1))");
    assert.equal(sexp(expr("f(consume buf, 2)")), "(call f (consume buf) 2)");
  });

  it("continues expressions after a trailing operator or before a leading dot", () => {
    assert.equal(sexp(expr("a +\n  b")), "(+ a b)");
    assert.equal(sexp(expr("items\n  .filter(ok)\n  .count()")), "(call (. (call (. items filter) ok) count))");
  });

  it("parses lambdas with expression and block bodies", () => {
    const a = expr("fn(x: int) => x * 2") as AST.LambdaExpression;
    assert.equal(a.body.kind, "BinaryExpression");
    const b = expr("fn(x) -> int {\n  return x\n}") as AST.LambdaExpression;
    assert.equal(b.body.kind, "BlockStatement");
    assert.equal(b.params[0]!.type, undefined);
  });

  it("parses control flow, including `else` on the next line", () => {
    const [stmt] = parse("if a {\n  x()\n}\nelse if b {\n  y()\n} else {\n  z()\n}").body as [AST.IfStatement];
    assert.equal(stmt.kind, "IfStatement");
    assert.equal(stmt.alternate?.kind, "IfStatement");
    assert.equal((stmt.alternate as AST.IfStatement).alternate?.kind, "BlockStatement");

    const [loop] = parse("for i in 0..10 {\n  print(i)\n}").body as [AST.ForStatement];
    assert.equal(loop.iterable.kind, "RangeExpression");
  });

  it("does not treat the `{` of an if body as an object literal", () => {
    const [stmt] = parse("if user == target { found = true }").body as [AST.IfStatement];
    assert.equal(sexp(stmt.test), "(== user target)");
  });

  it("parses models, imports and exports", () => {
    const program = parse(
      'import { Router, json as toJson } from "https://deno.land/x/oak/mod.ts"\n' +
        'import utils from "./utils.mk"\n' +
        'import * as path from "node:path"\n' +
        "export model User {\n  id: int\n  email: string?\n}\n" +
        "export fn hello() {}\n",
    );
    const [named, def, ns, model, fn] = program.body as [AST.ImportDeclaration, AST.ImportDeclaration, AST.ImportDeclaration, AST.ModelDeclaration, AST.FunctionDeclaration];
    assert.deepEqual(named.specifiers.map((s) => [s.imported, s.local]), [["Router", "Router"], ["json", "toJson"]]);
    assert.equal(named.source, "https://deno.land/x/oak/mod.ts");
    assert.equal(def.defaultBinding?.local, "utils");
    assert.equal(ns.namespaceBinding?.local, "path");
    assert.deepEqual(model.fields.map((f) => f.name), ["id", "email"]);
    assert.equal((model.fields[1]!.type as AST.TypeReference).optional, true);
    assert.equal(model.exported && fn.exported, true);
  });

  it("parses string interpolation into sub-expressions", () => {
    const t = expr('"total: ${a + b}!"') as AST.TemplateLiteral;
    assert.deepEqual(t.quasis, ["total: ", "!"]);
    assert.equal(sexp(t.expressions[0]!), "(+ a b)");
    assert.equal(t.expressions[0]!.span.start.column, 11);
  });

  it("attaches comments to statements", () => {
    const program = parse("// first\nlet a = 1 // trailing\n\nfn f() {\n  x()\n  // dangling\n}\n// end");
    const [a, f] = program.body as [AST.VariableDeclaration, AST.FunctionDeclaration];
    assert.equal(a.leadingComments?.[0]?.text, " first");
    assert.equal(a.trailingComment?.text, " trailing");
    assert.equal(f.body.danglingComments?.[0]?.text, " dangling");
    assert.equal(program.trailingComments[0]?.text, " end");
  });

  it("reports syntax errors with line and column, and recovers", () => {
    const { diagnostics } = Parser.parse("let = 5\nfn ok() {}\nsignal x 3\nlet y = (1 +\nprint(y)");
    const found = diagnostics.items.map((d) => `${d.span.start.line}:${d.span.start.column}`);
    assert.ok(diagnostics.items.length >= 2, "expected several errors");
    assert.equal(found[0], "1:5");
    assert.match(diagnostics.items[0]!.message, /expected a variable name after 'let'/);
    assert.equal(found[1], "3:10");
    assert.match(diagnostics.items[1]!.message, /expected '=' after signal 'x'/);
  });

  it("requires parameter type annotations on named functions", () => {
    const { diagnostics } = Parser.parse("fn f(x) {}");
    assert.equal(diagnostics.items[0]?.code, "MK2020");
  });
});
