import type * as AST from "../ast/nodes.js";
import type { AnalysisResult, ModelInfo } from "../analyzer/Analyzer.js";
import type { Comment } from "../lexer/Token.js";
import { VERSION } from "../version.js";

export interface CodegenOptions {
  /** `ts` emits annotated TypeScript; `js` emits the same program with types erased. */
  target: "ts" | "js";
  /** Module specifier of the MK runtime. */
  runtimeImport: string;
  /** Maps an import specifier as written in MK to the one emitted (URL cache paths, `.mk` → `.js`). */
  rewriteImport?: (specifier: string) => string;
  /** Emit a call to `main()` at the end of the module. */
  entry: boolean;
  /** Shown in the header comment. */
  sourceName: string;
  /** Original MK source, used to quote failing `assert` expressions. */
  source?: string;
}

/** Where a lowered `match` puts each arm's value. */
type MatchTarget = { kind: "assign"; name: string } | { kind: "return" } | { kind: "discard" };

interface Emitted {
  code: string;
  prec: number;
}

/** JavaScript operator precedence (higher binds tighter). */
const PREC = {
  assign: 2,
  nullish: 3,
  or: 4,
  and: 5,
  equality: 9,
  relational: 10,
  additive: 12,
  multiplicative: 13,
  unary: 15,
  postfix: 17,
  primary: 20,
} as const;

const BINARY: Record<Exclude<AST.BinaryOperator, "in">, [js: string, prec: number]> = {
  "??": ["??", PREC.nullish],
  "||": ["||", PREC.or],
  "&&": ["&&", PREC.and],
  "==": ["===", PREC.equality],
  "!=": ["!==", PREC.equality],
  "<": ["<", PREC.relational],
  "<=": ["<=", PREC.relational],
  ">": [">", PREC.relational],
  ">=": [">=", PREC.relational],
  "+": ["+", PREC.additive],
  "-": ["-", PREC.additive],
  "*": ["*", PREC.multiplicative],
  "/": ["/", PREC.multiplicative],
  "%": ["%", PREC.multiplicative],
};

/** Query-builder helper for each operator usable on columns. */
const QUERY_OPS: Record<string, string> = {
  "==": "eq",
  "!=": "ne",
  "<": "lt",
  "<=": "lte",
  ">": "gt",
  ">=": "gte",
  "&&": "and",
  "||": "or",
  "+": "add",
  "-": "sub",
  "*": "mul",
  "/": "div",
  "%": "mod",
  in: "in",
};

const JS_RESERVED = new Set(
  (
    "break case catch class const continue debugger default delete do else enum export extends false finally for " +
    "function if import in instanceof new null return super switch this throw true try typeof var void while with " +
    "yield let static implements interface package private protected public await arguments eval undefined"
  ).split(" "),
);

const PRIMITIVE_TS: Record<string, string> = {
  int: "number",
  float: "number",
  string: "string",
  bool: "boolean",
  void: "void",
  any: "any",
};

/**
 * Emits readable TypeScript (or JavaScript) from an analyzed MK program.
 *
 * - `signal x = v` → `$mk.signal(v)`, or `$mk.computed(() => ...)` when derived; reads become `x.value`.
 * - Functions the analyzer marked as I/O-performing become `async`, and exactly the calls that
 *   reach I/O are awaited — MK source never spells `async`/`await`.
 * - `query` / `insert` / `update` / `delete` become parameterized query-builder chains.
 * - `consume x` erases to `x`: ownership is enforced at compile time, at zero runtime cost.
 */
export class CodeGenerator {
  private out: string[] = [];
  private indent = 0;
  /**
   * Statements that must run before the statement being emitted. `match` and `?` inside an
   * expression are lowered to plain `if`s and early returns here, so the output stays readable.
   */
  private pending: string[] = [];
  private temps = 0;
  private usesRuntime = false;
  private readonly ts: boolean;

  constructor(
    private readonly analysis: AnalysisResult,
    private readonly options: CodegenOptions,
  ) {
    this.ts = options.target === "ts";
  }

  static generate(program: AST.Program, analysis: AnalysisResult, options: CodegenOptions): string {
    return new CodeGenerator(analysis, options).program(program);
  }

  program(program: AST.Program): string {
    const imports = program.body.filter((s): s is AST.ImportDeclaration => s.kind === "ImportDeclaration");
    const models = program.body.filter((s): s is AST.ModelDeclaration => s.kind === "ModelDeclaration");
    const enums = program.body.filter((s): s is AST.EnumDeclaration => s.kind === "EnumDeclaration");
    const hoisted = new Set<string>(["ImportDeclaration", "ModelDeclaration", "EnumDeclaration"]);
    const rest = program.body.filter((s) => !hoisted.has(s.kind));

    for (const stmt of imports) this.statement(stmt);
    if (imports.length) this.blank();

    // Models are hoisted: declare every schema before any code can query it.
    const implicit = [...this.analysis.models.values()].filter((m) => m.origin === "implicit");
    for (const model of implicit) this.implicitModel(model);
    for (const stmt of models) this.statement(stmt);
    if (implicit.length || models.length) this.blank();
    enums.forEach((stmt, i) => {
      if (i > 0) this.blank();
      this.statement(stmt);
    });
    if (enums.length) this.blank();

    rest.forEach((stmt, i) => {
      if (i > 0 && needsBlankLine(rest[i - 1]!, stmt)) this.blank();
      this.statement(stmt);
    });
    for (const c of program.trailingComments) this.comment(c);

    if (this.options.entry) this.epilogue();

    const header = [`// Generated by mk ${VERSION} from ${this.options.sourceName}. Do not edit.`];
    if (this.usesRuntime) header.push(`import * as $mk from ${JSON.stringify(this.options.runtimeImport)};`);
    return [...header, ...(this.out[0] === "" ? [] : [""]), ...trimTrailingBlank(this.out), ""].join("\n");
  }

  /** Entry module: run tests under `mk test`, otherwise `main()`, then serve routes under `mk serve`. */
  private epilogue(): void {
    const main = this.analysis.main;
    const run: string[] = [];
    if (main) run.push(main.isAsync ? "await main();" : "main();");
    if (this.analysis.hasRoutes) run.push("await $mk.http.autoServe();");
    if (!this.analysis.hasTests && !run.length) return;
    this.blank();
    if (!this.analysis.hasTests) {
      for (const line of run) this.line(line);
      return;
    }
    this.usesRuntime = true;
    if (!run.length) {
      this.line("if ($mk.testing()) await $mk.runTests();");
      return;
    }
    this.line("if ($mk.testing()) {");
    this.line("  await $mk.runTests();");
    this.line("} else {");
    for (const line of run) this.line(`  ${line}`);
    this.line("}");
  }

  // -------------------------------------------------------------------------
  // Statements
  // -------------------------------------------------------------------------

  private statement(stmt: AST.Statement): void {
    for (const c of stmt.leadingComments ?? []) this.comment(c);
    const savedPending = this.pending;
    this.pending = [];
    const mark = this.out.length;
    this.statementBody(stmt);
    if (this.pending.length) this.out.splice(mark, 0, ...this.pending);
    this.pending = savedPending;
    const before = mark;
    if (stmt.trailingComment && this.out.length > before) {
      const c = stmt.trailingComment;
      const last = this.out.length - 1;
      this.out[last] += c.kind === "line" ? ` //${c.text}` : ` /*${c.text}*/`;
    }
  }

  private statementBody(stmt: AST.Statement): void {
    switch (stmt.kind) {
      case "ImportDeclaration":
        return this.importDeclaration(stmt);
      case "ModelDeclaration":
        return this.modelDeclaration(stmt);
      case "EnumDeclaration":
        return this.enumDeclaration(stmt);
      case "RouteDeclaration":
        return this.routeDeclaration(stmt);
      case "TestDeclaration":
        this.usesRuntime = true;
        this.line(`$mk.test(${JSON.stringify(stmt.name)}, async () => {`);
        this.blockContents(stmt.body);
        this.line("});");
        return;
      case "AssertStatement":
        return this.assertStatement(stmt);
      case "FunctionDeclaration": {
        if (stmt.isView) return this.viewDeclaration(stmt);
        const asyncKw = stmt.isAsync ? "async " : "";
        const exportKw = stmt.exported ? "export " : "";
        const ret = this.returnAnnotation(stmt.returnType, !!stmt.isAsync);
        this.line(`${exportKw}${asyncKw}function ${mangle(stmt.name)}(${this.params(stmt.params)})${ret} {`);
        this.blockContents(stmt.body);
        this.line("}");
        return;
      }
      case "VariableDeclaration": {
        const kw = stmt.mutable ? "let" : "const";
        const type = this.ts && stmt.type ? `: ${this.tsType(stmt.type)}` : "";
        const exportKw = stmt.exported ? "export " : "";
        if (stmt.init.kind === "MatchExpression") {
          this.line(`${exportKw}let ${mangle(stmt.name)}${type};`);
          this.lowerMatch(stmt.init, { kind: "assign", name: mangle(stmt.name) });
          return;
        }
        this.line(`${exportKw}${kw} ${mangle(stmt.name)}${type} = ${this.expr(stmt.init).code};`);
        return;
      }
      case "SignalDeclaration": {
        if (stmt.init.kind === "QueryExpression" && stmt.init.live) return this.liveSignal(stmt, stmt.init);
        const generic = this.ts && stmt.type ? `<${this.tsType(stmt.type)}>` : "";
        const init = stmt.derived
          ? `$mk.computed${generic}(() => ${this.arrowBody(stmt.init)})`
          : `$mk.signal${generic}(${this.expr(stmt.init).code})`;
        this.usesRuntime = true;
        this.line(`${stmt.exported ? "export " : ""}const ${mangle(stmt.name)} = ${init};`);
        return;
      }
      case "BlockStatement":
        this.line("{");
        this.blockContents(stmt);
        this.line("}");
        return;
      case "EffectStatement":
        this.usesRuntime = true;
        this.line(`$mk.effect(${stmt.isAsync ? "async " : ""}() => {`);
        this.blockContents(stmt.body);
        this.line("});");
        return;
      case "ReturnStatement":
        if (stmt.value?.kind === "MatchExpression") return this.lowerMatch(stmt.value, { kind: "return" });
        this.line(stmt.value ? `return ${this.expr(stmt.value).code};` : "return;");
        return;
      case "IfStatement":
        this.ifStatement(stmt, "");
        return;
      case "WhileStatement":
        this.line(`while (${this.expr(stmt.test).code}) {`);
        this.blockContents(stmt.body);
        this.line("}");
        return;
      case "ForStatement": {
        const v = mangle(stmt.variable);
        if (stmt.iterable.kind === "RangeExpression") {
          const start = this.expr(stmt.iterable.start).code;
          const end = this.wrap(stmt.iterable.end, PREC.relational + 1);
          this.line(`for (let ${v} = ${start}; ${v} < ${end}; ${v}++) {`);
        } else {
          this.line(`for (const ${v} of ${this.wrap(stmt.iterable, PREC.assign)}) {`);
        }
        this.blockContents(stmt.body);
        this.line("}");
        return;
      }
      case "BreakStatement":
        this.line("break;");
        return;
      case "ContinueStatement":
        this.line("continue;");
        return;
      case "ExpressionStatement": {
        if (stmt.expression.kind === "MatchExpression") return this.lowerMatch(stmt.expression, { kind: "discard" });
        const code = this.expr(stmt.expression).code;
        this.line(/^(\{|function\b|class\b|let\s*\[)/.test(code) ? `(${code});` : `${code};`);
        return;
      }
    }
  }

  private ifStatement(stmt: AST.IfStatement, prefix: string): void {
    this.line(`${prefix}if (${this.expr(stmt.test).code}) {`);
    this.blockContents(stmt.consequent);
    if (!stmt.alternate) {
      this.line("}");
    } else if (stmt.alternate.kind === "IfStatement") {
      const alternate = stmt.alternate;
      // An else-if condition that needs lowered statements must only run when reached.
      const { pre } = this.capture(() => this.expr(alternate.test), 1);
      if (!pre.length) return this.ifStatement(alternate, "} else ");
      this.line("} else {");
      this.indent++;
      this.statement({ ...alternate, leadingComments: undefined, trailingComment: undefined });
      this.indent--;
      this.line("}");
    } else {
      this.line("} else {");
      this.blockContents(stmt.alternate);
      this.line("}");
    }
  }

  private blockContents(block: AST.BlockStatement): void {
    this.indent++;
    block.body.forEach((stmt, i) => {
      if (i > 0 && hadBlankLine(block.body[i - 1]!, stmt)) this.blank();
      this.statement(stmt);
    });
    for (const c of block.danglingComments ?? []) this.comment(c);
    this.indent--;
  }

  private enumDeclaration(stmt: AST.EnumDeclaration): void {
    const exportKw = stmt.exported ? "export " : "";
    const name = stmt.name;
    if (this.ts) {
      this.line(`${exportKw}type ${name} =`);
      stmt.variants.forEach((v, i) => {
        const fields = v.fields.map((f) => `; ${safeKey(f.name)}: ${this.tsType(f.type)}`).join("");
        this.line(`  | { tag: ${JSON.stringify(v.name)}${fields} }${i === stmt.variants.length - 1 ? ";" : ""}`);
      });
    }
    for (const v of stmt.variants) {
      const tag = `tag: ${JSON.stringify(v.name)}`;
      if (!v.fields.length) {
        this.line(`${exportKw}const ${mangle(v.name)}${this.ts ? `: ${name}` : ""} = { ${tag} };`);
        continue;
      }
      const params = v.fields.map((f) => `${mangle(f.name)}${this.ts ? `: ${this.tsType(f.type)}` : ""}`).join(", ");
      const values = v.fields.map((f) => (safeKey(f.name) === mangle(f.name) ? f.name : `${safeKey(f.name)}: ${mangle(f.name)}`)).join(", ");
      this.line(`${exportKw}const ${mangle(v.name)} = (${params})${this.ts ? `: ${name}` : ""} => ({ ${tag}, ${values} });`);
    }
    this.line(`${exportKw}const ${name} = { ${stmt.variants.map((v) => mangle(v.name)).join(", ")} }${this.ts ? " as const" : ""};`);
  }

  private routeDeclaration(stmt: AST.RouteDeclaration): void {
    this.usesRuntime = true;
    const spec = stmt.params.map((p) => `${safeKey(p.name)}: ${JSON.stringify(columnType(p.type!) + (p.defaultValue && !p.type?.optional ? "?" : ""))}`);
    let handler = "async () =>";
    if (stmt.params.length) {
      const names = stmt.params.map((p) => (p.defaultValue ? `${mangle(p.name)} = ${this.wrap(p.defaultValue, PREC.assign)}` : mangle(p.name)));
      const type = this.ts
        ? `: { ${stmt.params.map((p) => `${safeKey(p.name)}${p.defaultValue ? "?" : ""}: ${this.tsType(p.type!)}`).join("; ")} }`
        : "";
      handler = `async ({ ${names.join(", ")} }${type}) =>`;
    }
    const args = [JSON.stringify(stmt.method), JSON.stringify(stmt.path), `{ ${spec.join(", ")} }`].join(", ");
    this.line(`$mk.http.route(${args.replace("{  }", "{}")}, ${handler} {`);
    this.blockContents(stmt.body);
    this.line("});");
  }

  private assertStatement(stmt: AST.AssertStatement): void {
    this.usesRuntime = true;
    const text = JSON.stringify(this.sourceText(stmt.test));
    const where = JSON.stringify(`${this.options.sourceName}:${stmt.span.start.line}`);
    const message = stmt.message ? `, ${this.wrap(stmt.message, PREC.assign)}` : "";
    const t = stmt.test;
    if (t.kind === "BinaryExpression" && t.operator === "==") {
      const left = this.wrap(t.left, PREC.assign);
      const right = this.wrap(t.right, PREC.assign);
      this.line(`$mk.assertEqual(${left}, ${right}, ${text}, ${where}${message});`);
    } else {
      this.line(`$mk.assert(${this.wrap(t, PREC.assign)}, ${text}, ${where}${message});`);
    }
  }

  private viewDeclaration(stmt: AST.FunctionDeclaration): void {
    this.usesRuntime = true;
    const exportKw = stmt.exported ? "export " : "";
    let props = "";
    if (stmt.params.length) {
      const names = stmt.params.map((p) => (p.defaultValue ? `${mangle(p.name)} = ${this.wrap(p.defaultValue, PREC.assign)}` : mangle(p.name)));
      const optional = stmt.params.every((p) => p.defaultValue);
      const type = this.ts
        ? `: { ${stmt.params.map((p) => `${safeKey(p.name)}${p.defaultValue ? "?" : ""}: ${this.tsType(p.type!)}`).join("; ")} }`
        : "";
      props = `{ ${names.join(", ")} }${type}${optional ? " = {}" : ""}`;
    }
    this.line(`${exportKw}function ${mangle(stmt.name)}(${props})${this.ts ? ": $mk.Markup" : ""} {`);
    const body = stmt.body.body;
    const last = body[body.length - 1];
    this.blockContents({ ...stmt.body, body: body.slice(0, -1) });
    if (last?.kind === "ExpressionStatement") {
      this.indent++;
      this.statement({ kind: "ReturnStatement", value: last.expression, span: last.span, leadingComments: last.leadingComments });
      this.indent--;
    }
    this.line("}");
  }

  private liveSignal(stmt: AST.SignalDeclaration, query: AST.QueryExpression): void {
    this.usesRuntime = true;
    const run = this.query(query, false).code;
    const name = mangle(stmt.name);
    const initial = query.mode === "count" ? "0" : query.mode === "first" ? "null" : "[]";
    this.line(`${stmt.exported ? "export " : ""}const ${name} = $mk.live(${this.modelRef(query.model)}, () => ${run}, ${initial});`);
    if (query.liveAwait) this.line(`await ${name}.loaded;`);
  }

  // -------------------------------------------------------------------------
  // match lowering
  // -------------------------------------------------------------------------

  /**
   * `match` becomes an if/else chain over the subject's `tag` (or value). With guards it becomes
   * a labeled block, so a failing guard falls through to the next arm.
   */
  private lowerMatch(node: AST.MatchExpression, target: MatchTarget): void {
    let subject = this.expr(node.subject).code;
    if (node.subject.kind !== "Identifier" || /\./.test(subject)) {
      const tmp = this.temp("m");
      this.line(`const ${tmp} = ${subject};`);
      subject = tmp;
    }
    const guarded = node.arms.some((a) => a.guard);
    if (!guarded) {
      let open = false;
      node.arms.some((arm, i) => {
        const test = patternTest(arm.pattern, subject, (e) => this.expr(e).code);
        const last = i === node.arms.length - 1 || test === null;
        // A nested pattern (`Err(Negative(v))`) keeps its test even last, so TypeScript narrows the fields.
        const keepTest = last && test !== null && hasNestedTest(arm.pattern);
        if (i === 0 && last && !keepTest) this.line("{");
        else if (i === 0) this.line(`if (${test}) {`);
        else if (last && !keepTest) this.line("} else {");
        else this.line(`} else if (${test}) {`);
        open = keepTest;
        this.indent++;
        this.bindings(arm.pattern, subject);
        this.armBody(arm, target);
        this.indent--;
        if (last) this.line("}");
        return last;
      });
      // Unreachable (the match is exhaustive), but lets TypeScript see that every path returns.
      if (open && target.kind === "return") this.line('throw new Error("unreachable: no match arm matched");');
      return;
    }
    const label = target.kind === "return" ? undefined : this.temp("match");
    if (label) {
      this.line(`${label}: {`);
      this.indent++;
    }
    const exit = label ? `break ${label};` : undefined;
    for (const [i, arm] of node.arms.entries()) {
      // The analyzer proved the match exhaustive, so the last unguarded arm needs no test.
      const final = i === node.arms.length - 1 && !arm.guard;
      const test = final ? null : patternTest(arm.pattern, subject, (e) => this.expr(e).code);
      this.line(test === null ? "{" : `if (${test}) {`);
      this.indent++;
      this.bindings(arm.pattern, subject);
      if (arm.guard) {
        this.line(`if (${this.expr(arm.guard).code}) {`);
        this.indent++;
      }
      this.armBody(arm, target);
      if (exit) this.line(exit);
      if (arm.guard) {
        this.indent--;
        this.line("}");
      }
      this.indent--;
      this.line("}");
      if (test === null && !arm.guard) break;
    }
    if (label) {
      this.indent--;
      this.line("}");
    }
  }

  private bindings(pattern: AST.Pattern, subject: string): void {
    if (pattern.kind === "BindingPattern") this.line(`const ${mangle(pattern.name)} = ${subject};`);
    if (pattern.kind !== "VariantPattern") return;
    pattern.args.forEach((arg, i) => {
      const field = pattern.fieldNames?.[i];
      if (field) this.bindings(arg, `${subject}.${field}`);
    });
  }

  private armBody(arm: AST.MatchArm, target: MatchTarget): void {
    const emitValue = (value: AST.Expression) => {
      if (value.kind === "MatchExpression") return this.lowerMatch(value, target);
      const { value: code, pre } = this.capture(() => this.expr(value).code);
      this.out.push(...pre);
      if (target.kind === "assign") this.line(`${target.name} = ${code};`);
      else if (target.kind === "return") this.line(`return ${code};`);
      else this.line(`${code};`);
    };
    if (arm.body.kind !== "BlockStatement") return emitValue(arm.body);
    const body = arm.body.body;
    const last = body[body.length - 1];
    const valued = last?.kind === "ExpressionStatement" && target.kind !== "discard";
    for (const stmt of valued ? body.slice(0, -1) : body) this.statement(stmt);
    if (valued) {
      for (const c of last.leadingComments ?? []) this.comment(c);
      emitValue(last.expression);
    }
  }

  private temp(prefix: string): string {
    return `$${prefix}${++this.temps}`;
  }

  /** Renders with a fresh pre-statement buffer; returns the value and the statements it needs. */
  private capture<T>(fn: () => T, extraIndent = 0): { value: T; pre: string[] } {
    const saved = this.pending;
    this.pending = [];
    this.indent += extraIndent;
    try {
      const value = fn();
      return { value, pre: this.pending };
    } finally {
      this.indent -= extraIndent;
      this.pending = saved;
    }
  }

  /** Lines emitted by `fn`, without adding them to the output. */
  private collect(fn: () => void): string[] {
    const saved = this.out;
    this.out = [];
    try {
      fn();
      return this.out;
    } finally {
      this.out = saved;
    }
  }

  private sourceText(node: AST.NodeBase): string {
    return this.options.source?.slice(node.span.start.offset, node.span.end.offset) ?? "assertion";
  }

  // -------------------------------------------------------------------------
  // Markup
  // -------------------------------------------------------------------------

  /** `$mk.h(tag, attrs, children)`; dynamic parts become thunks the runtime re-runs on change. */
  private markup(node: AST.MarkupElement): string {
    this.usesRuntime = true;
    if (node.component) {
      const props = node.attributes.map((a) => `${safeKey(a.name)}: ${a.value === true ? "true" : this.wrap(a.value, PREC.assign)}`);
      return `${mangle(node.tag)}(${props.length ? `{ ${props.join(", ")} }` : ""})`;
    }
    const attrs = node.attributes.map((a) => {
      const key = safeKey(a.name);
      if (a.value === true) return `${key}: true`;
      if (a.value.kind === "StringLiteral") return `${key}: ${JSON.stringify(a.value.value)}`;
      if (a.name.startsWith("on:")) return `${key}: ${this.handler(a.value, !!a.isAsync)}`;
      if (a.name.startsWith("bind:") && a.value.kind === "Identifier") return `${key}: ${mangle(a.value.name)}`;
      return `${key}: ${this.thunk(a.value)}`;
    });
    this.indent++;
    const children = node.children.map((c) =>
      c.kind === "MarkupText" ? JSON.stringify(c.value) : c.kind === "MarkupElement" ? this.markup(c) : this.thunk(c),
    );
    this.indent--;
    const head = `$mk.h(${JSON.stringify(node.tag)}, ${attrs.length ? `{ ${attrs.join(", ")} }` : "{}"}`;
    if (!children.length) return `${head})`;
    const flat = `${head}, [${children.join(", ")}])`;
    if (flat.length + this.indent * 2 <= 96 && !flat.includes("\n")) return flat;
    const pad = "  ".repeat(this.indent + 1);
    return `${head}, [\n${children.map((c) => pad + c).join(",\n")},\n${"  ".repeat(this.indent)}])`;
  }

  private thunk(expr: AST.Expression): string {
    if (expr.kind === "StringLiteral" || expr.kind === "NumberLiteral" || expr.kind === "BooleanLiteral") return this.expr(expr).code;
    if (expr.kind === "MarkupElement") return this.markup(expr);
    return `() => ${this.arrowBody(expr)}`;
  }

  private handler(expr: AST.Expression, isAsync: boolean): string {
    if (expr.kind === "LambdaExpression") return this.expr(expr).code;
    const { value, pre } = this.capture(() => this.expr(expr).code, 1);
    const asyncKw = isAsync ? "async " : "";
    if (!pre.length) return `${asyncKw}() => { ${value}; }`;
    const pad = "  ".repeat(this.indent + 1);
    return `${asyncKw}() => {\n${pre.join("\n")}\n${pad}${value};\n${"  ".repeat(this.indent)}}`;
  }

  private importDeclaration(stmt: AST.ImportDeclaration): void {
    const source = JSON.stringify(this.options.rewriteImport?.(stmt.source) ?? stmt.source);
    const parts: string[] = [];
    if (stmt.defaultBinding) parts.push(mangle(stmt.defaultBinding.local));
    if (stmt.namespaceBinding) parts.push(`* as ${mangle(stmt.namespaceBinding.local)}`);
    if (stmt.specifiers.length) {
      const names = stmt.specifiers.map((s) =>
        s.imported === s.local && !JS_RESERVED.has(s.local) ? s.local : `${s.imported} as ${mangle(s.local)}`,
      );
      parts.push(`{ ${names.join(", ")} }`);
    }
    this.line(`import ${parts.join(", ")} from ${source};`);
  }

  private modelDeclaration(stmt: AST.ModelDeclaration): void {
    this.usesRuntime = true;
    const exportKw = stmt.exported ? "export " : "";
    if (this.ts) {
      const fields = stmt.fields.map((f) => `${safeKey(f.name)}: ${this.tsType(f.type)};`);
      this.line(`${exportKw}interface ${stmt.name} {`);
      this.indent++;
      for (const f of fields) this.line(f);
      this.indent--;
      this.line("}");
    }
    const schema = stmt.fields.map((f) => `${safeKey(f.name)}: ${JSON.stringify(columnType(f.type))}`).join(", ");
    const generic = this.ts ? `<${stmt.name}>` : "";
    this.line(`${exportKw}const ${stmt.name} = $mk.db.model${generic}(${JSON.stringify(stmt.name)}, { ${schema} });`);
  }

  private implicitModel(model: ModelInfo): void {
    this.usesRuntime = true;
    this.line(`// Model '${model.name}' has no schema declaration; its columns are untyped.`);
    if (this.ts) this.line(`interface ${model.name} { [column: string]: any }`);
    const generic = this.ts ? `<${model.name}>` : "";
    this.line(`const ${model.name} = $mk.db.model${generic}(${JSON.stringify(model.name)});`);
  }

  // -------------------------------------------------------------------------
  // Expressions
  // -------------------------------------------------------------------------

  private expr(node: AST.Expression): Emitted {
    switch (node.kind) {
      case "MatchExpression": {
        const tmp = this.temp("v");
        this.pending.push(
          ...this.collect(() => {
            this.line(`let ${tmp};`);
            this.lowerMatch(node, { kind: "assign", name: tmp });
          }),
        );
        return primary(tmp);
      }
      case "TryExpression": {
        this.usesRuntime = true;
        const operand = this.expr(node.operand).code;
        const tmp = this.temp("r");
        this.pending.push(
          ...this.collect(() => {
            this.line(`const ${tmp} = ${operand};`);
            this.line(`if (${tmp}.tag === "Err") return $mk.Err(${tmp}.error);`);
          }),
        );
        return { code: `${tmp}.value`, prec: PREC.postfix };
      }
      case "MarkupElement":
        return primary(this.markup(node));
      case "NumberLiteral":
        return primary(node.raw);
      case "StringLiteral":
        return primary(JSON.stringify(node.value));
      case "TemplateLiteral": {
        let code = "`";
        node.quasis.forEach((q, i) => {
          code += escapeTemplate(q);
          const e = node.expressions[i];
          if (e) code += "${" + this.expr(e).code + "}";
        });
        return primary(code + "`");
      }
      case "BooleanLiteral":
        return primary(String(node.value));
      case "NullLiteral":
        return primary("null");
      case "Identifier":
        return this.identifier(node);
      case "ListLiteral":
        return primary(`[${node.elements.map((e) => this.wrap(e, PREC.assign)).join(", ")}]`);
      case "ObjectLiteral":
        return primary(this.objectLiteral(node, (e) => this.wrap(e, PREC.assign)));
      case "BinaryExpression":
        return this.binary(node);
      case "UnaryExpression":
        return { code: `${node.operator}${this.wrap(node.operand, PREC.unary)}`, prec: PREC.unary };
      case "AssignmentExpression": {
        const target = node.target.kind === "Identifier" ? this.identifier(node.target).code : this.expr(node.target).code;
        return { code: `${target} ${node.operator} ${this.wrap(node.value, PREC.assign)}`, prec: PREC.assign };
      }
      case "CallExpression":
        return this.call(node);
      case "MemberExpression":
        return { code: `${this.wrap(node.object, PREC.postfix)}${node.optional ? "?." : "."}${node.property}`, prec: PREC.postfix };
      case "IndexExpression":
        return { code: `${this.wrap(node.object, PREC.postfix)}[${this.expr(node.index).code}]`, prec: PREC.postfix };
      case "RangeExpression":
        return this.runtime(`$mk.range(${this.expr(node.start).code}, ${this.expr(node.end).code})`);
      case "LambdaExpression":
        return this.lambda(node);
      case "ConsumeExpression":
        // Ownership is a compile-time property: the move itself is free.
        return this.expr(node.argument);
      case "SpawnExpression": {
        this.usesRuntime = true;
        const body = node.body.kind === "BlockStatement" ? this.inlineBlock(node.body) : this.arrowBody(node.body);
        return primary(`$mk.spawn(async () => ${body})`);
      }
      case "QueryExpression":
        return this.query(node);
      case "InsertExpression": {
        this.usesRuntime = true;
        const value = this.objectLiteral(node.value, (e) => this.wrap(e, PREC.assign));
        return { code: `await $mk.db.insert(${this.modelRef(node.model)}, ${value})`, prec: PREC.unary };
      }
      case "UpdateExpression": {
        this.usesRuntime = true;
        const set = node.assignments.map((a) => `${safeKey(a.column)}: ${this.predicate(a.value)}`).join(", ");
        return this.chain(node.model, node.where ? [`where(${this.predicate(node.where)})`] : [], `update({ ${set} })`);
      }
      case "DeleteExpression":
        this.usesRuntime = true;
        return this.chain(node.model, node.where ? [`where(${this.predicate(node.where)})`] : [], "delete()");
    }
  }

  private identifier(node: AST.Identifier): Emitted {
    const sym = this.analysis.resolutions.get(node);
    if (sym?.kind === "signal") return { code: `${mangle(node.name)}.value`, prec: PREC.postfix };
    if (sym?.kind === "builtin" && sym.builtin) {
      if (sym.builtin.emit.startsWith("$mk.")) this.usesRuntime = true;
      return primary(sym.builtin.emit);
    }
    return primary(mangle(node.name));
  }

  private binary(node: AST.BinaryExpression): Emitted {
    if (node.operator === "in") {
      return this.runtime(`$mk.contains(${this.expr(node.right).code}, ${this.expr(node.left).code})`);
    }
    const [op, prec] = BINARY[node.operator];
    // `x == null` stays loose so it also matches `undefined` from optional chaining / host APIs.
    const isNullCheck = (node.operator === "==" || node.operator === "!=") && (node.left.kind === "NullLiteral" || node.right.kind === "NullLiteral");
    const jsOp = isNullCheck ? node.operator : op;
    // JavaScript forbids mixing `??` with `&&` / `||` without parentheses.
    const mixesNullish = (child: AST.Expression) =>
      child.kind === "BinaryExpression" &&
      (node.operator === "??") !== (child.operator === "??") &&
      ["??", "&&", "||"].includes(child.operator) &&
      ["??", "&&", "||"].includes(node.operator);
    const left = mixesNullish(node.left) ? `(${this.expr(node.left).code})` : this.wrap(node.left, prec);
    const right = mixesNullish(node.right) ? `(${this.expr(node.right).code})` : this.wrap(node.right, prec + 1);
    return { code: `${left} ${jsOp} ${right}`, prec };
  }

  private call(node: AST.CallExpression): Emitted {
    const args = node.args.map((a) => this.wrap(a, PREC.assign)).join(", ");
    const callee = this.wrap(node.callee, PREC.postfix);
    if (node.construct) return { code: `new ${callee}(${args})`, prec: PREC.postfix };
    const code = `${callee}(${args})`;
    return node.await ? { code: `await ${code}`, prec: PREC.unary } : { code, prec: PREC.postfix };
  }

  private lambda(node: AST.LambdaExpression): Emitted {
    const asyncKw = node.isAsync ? "async " : "";
    const ret = this.ts && node.returnType ? this.returnAnnotation(node.returnType, !!node.isAsync) : "";
    const body = node.body.kind === "BlockStatement" ? this.inlineBlock(node.body) : this.arrowBody(node.body);
    return { code: `${asyncKw}(${this.params(node.params)})${ret} => ${body}`, prec: PREC.assign };
  }

  /** Expression body of an arrow function; object literals need parentheses. */
  private arrowBody(node: AST.Expression): string {
    const { value: code, pre } = this.capture(() => this.wrap(node, PREC.assign), 1);
    if (pre.length) {
      const pad = "  ".repeat(this.indent + 1);
      return `{\n${pre.join("\n")}\n${pad}return ${code};\n${"  ".repeat(this.indent)}}`;
    }
    return code.startsWith("{") ? `(${code})` : code;
  }

  /** A block rendered as an expression-position `{ ... }` (lambda / spawn bodies). */
  private inlineBlock(block: AST.BlockStatement): string {
    if (block.body.length === 0 && !block.danglingComments?.length) return "{}";
    const saved = this.out.length;
    this.blockContents(block);
    const lines = this.out.splice(saved);
    return `{\n${lines.join("\n")}\n${"  ".repeat(this.indent)}}`;
  }

  private objectLiteral(node: AST.ObjectLiteral, value: (e: AST.Expression) => string): string {
    if (node.properties.length === 0) return "{}";
    const props = node.properties.map((p) => {
      if (p.shorthand && p.value.kind === "Identifier") {
        const v = value(p.value);
        return v === p.key ? p.key : `${safeKey(p.key)}: ${v}`;
      }
      return `${safeKey(p.key)}: ${value(p.value)}`;
    });
    return `{ ${props.join(", ")} }`;
  }

  // -------------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------------

  private query(node: AST.QueryExpression, awaitResult = true): Emitted {
    this.usesRuntime = true;
    const steps: string[] = [];
    if (node.where) steps.push(`where(${this.predicate(node.where)})`);
    for (const o of node.orderBy) steps.push(`orderBy(${JSON.stringify(o.column)}, ${JSON.stringify(o.direction)})`);
    if (node.limit) steps.push(`limit(${this.expr(node.limit).code})`);
    if (node.offset) steps.push(`offset(${this.expr(node.offset).code})`);
    if (node.select) steps.push(`select(${node.select.map((c) => JSON.stringify(c.name)).join(", ")})`);
    const terminal = node.mode === "first" ? "first()" : node.mode === "count" ? "count()" : "all()";
    return this.chain(node.model, steps, terminal, awaitResult);
  }

  /** `await $mk.db.from(Model).step().step().terminal()`, broken across lines when long. */
  private chain(model: AST.ModelReference, steps: string[], terminal: string, awaitResult = true): Emitted {
    const parts = [`from(${this.modelRef(model)})`, ...steps, terminal];
    const lead = awaitResult ? "await " : "";
    const prec = awaitResult ? PREC.unary : PREC.postfix;
    const flat = `${lead}$mk.db.${parts.join(".")}`;
    if (flat.length + this.indent * 2 <= 96) return { code: flat, prec };
    const pad = "  ".repeat(this.indent + 1);
    return { code: `${lead}$mk.db\n${parts.map((p) => `${pad}.${p}`).join("\n")}`, prec };
  }

  private modelRef(model: AST.ModelReference): string {
    const info = this.analysis.models.get(model.name);
    return info?.origin === "foreign" ? JSON.stringify(model.name) : model.name;
  }

  /** Emits a predicate as query-builder IR; column-free sub-expressions become bound parameters. */
  private predicate(node: AST.Expression): string {
    if (!containsColumn(node)) return this.wrap(node, PREC.assign);
    switch (node.kind) {
      case "Identifier":
        return `$mk.q.col(${JSON.stringify(node.name)})`;
      case "BinaryExpression":
        return `$mk.q.${QUERY_OPS[node.operator]}(${this.predicate(node.left)}, ${this.predicate(node.right)})`;
      case "UnaryExpression":
        return `$mk.q.${node.operator === "!" ? "not" : "neg"}(${this.predicate(node.operand)})`;
      case "CallExpression": {
        const callee = node.callee as AST.MemberExpression;
        return `$mk.q.${callee.property}(${this.predicate(callee.object)}, ${node.args.map((a) => this.predicate(a)).join(", ")})`;
      }
      default:
        return this.wrap(node, PREC.assign);
    }
  }

  // -------------------------------------------------------------------------
  // Types & parameters
  // -------------------------------------------------------------------------

  private params(params: AST.Parameter[]): string {
    return params
      .map((p) => {
        const type = this.ts && p.type ? `: ${this.tsType(p.type)}` : "";
        const def = p.defaultValue ? ` = ${this.wrap(p.defaultValue, PREC.assign)}` : "";
        return `${mangle(p.name)}${type}${def}`;
      })
      .join(", ");
  }

  private returnAnnotation(type: AST.TypeNode | undefined, isAsync: boolean): string {
    if (!this.ts || !type) return "";
    const ts = this.tsType(type);
    return `: ${isAsync ? `Promise<${ts}>` : ts}`;
  }

  private tsType(node: AST.TypeNode): string {
    let ts: string;
    if (node.kind === "FunctionType") {
      ts = `(${node.params.map((p, i) => `arg${i}: ${this.tsType(p)}`).join(", ")}) => ${this.tsType(node.returnType)}`;
      if (node.optional) ts = `(${ts})`;
    } else if (node.name in PRIMITIVE_TS) {
      ts = PRIMITIVE_TS[node.name]!;
    } else if (node.name === "List") {
      const inner = node.args[0] ? this.tsType(node.args[0]) : "any";
      ts = /[|&=]/.test(inner) ? `(${inner})[]` : `${inner}[]`;
    } else if (node.name === "Task") {
      ts = `Promise<${node.args[0] ? this.tsType(node.args[0]) : "any"}>`;
    } else if (node.name === "Result") {
      this.usesRuntime = true;
      ts = `$mk.Result<${node.args.map((a) => this.tsType(a)).join(", ") || "any, any"}>`;
    } else if (node.name === "Markup" || node.name === "Html") {
      this.usesRuntime = true;
      ts = "$mk.Markup";
    } else {
      ts = node.args.length ? `${node.name}<${node.args.map((a) => this.tsType(a)).join(", ")}>` : node.name;
    }
    return node.optional ? `${ts} | null` : ts;
  }

  // -------------------------------------------------------------------------
  // Output helpers
  // -------------------------------------------------------------------------

  private wrap(node: AST.Expression, minPrec: number): string {
    const e = this.expr(node);
    return e.prec < minPrec ? `(${e.code})` : e.code;
  }

  private runtime(code: string): Emitted {
    this.usesRuntime = true;
    return primary(code);
  }

  private comment(c: Comment): void {
    if (c.kind === "line") this.line(`//${c.text}`);
    else this.line(`/*${c.text}*/`);
  }

  private line(text: string): void {
    this.out.push("  ".repeat(this.indent) + text);
  }

  private blank(): void {
    if (this.out.length && this.out[this.out.length - 1] !== "") this.out.push("");
  }
}

function escapeTemplate(text: string): string {
  return text
    .replace(/[`\\]/g, "\\$&")
    .replace(/\$\{/g, "\\${")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
}

function hasNestedTest(pattern: AST.Pattern): boolean {
  return pattern.kind === "VariantPattern" && pattern.args.some((a) => a.kind === "VariantPattern" || a.kind === "LiteralPattern");
}

/** JavaScript condition for a pattern, or `null` when it always matches. */
function patternTest(pattern: AST.Pattern, subject: string, literal: (e: AST.Expression) => string): string | null {
  switch (pattern.kind) {
    case "WildcardPattern":
    case "BindingPattern":
      return null;
    case "LiteralPattern":
      return pattern.value.kind === "NullLiteral" ? `${subject} == null` : `${subject} === ${literal(pattern.value)}`;
    case "VariantPattern": {
      const tests = [`${subject}.tag === ${JSON.stringify(pattern.name)}`];
      pattern.args.forEach((arg, i) => {
        const field = pattern.fieldNames?.[i];
        const inner = field ? patternTest(arg, `${subject}.${field}`, literal) : null;
        if (inner) tests.push(inner);
      });
      return tests.join(" && ");
    }
  }
}

function primary(code: string): Emitted {
  return { code, prec: PREC.primary };
}

function containsColumn(node: AST.Expression): boolean {
  switch (node.kind) {
    case "Identifier":
      return node.queryRole === "column";
    case "BinaryExpression":
      return containsColumn(node.left) || containsColumn(node.right);
    case "UnaryExpression":
      return containsColumn(node.operand);
    case "CallExpression":
      return node.callee.kind === "MemberExpression" && containsColumn(node.callee.object);
    default:
      return false;
  }
}

/** Runtime column descriptor for a model field, e.g. `"int"`, `"string?"`. */
function columnType(node: AST.TypeNode): string {
  const base = node.kind === "TypeReference" && ["int", "float", "string", "bool"].includes(node.name) ? node.name : "json";
  return node.optional ? `${base}?` : base;
}

function mangle(name: string): string {
  return JS_RESERVED.has(name) ? `${name}_` : name;
}

function safeKey(key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
}

function needsBlankLine(prev: AST.Statement, next: AST.Statement): boolean {
  const isBlocky = (s: AST.Statement) => s.kind === "FunctionDeclaration" || s.kind === "EffectStatement";
  return isBlocky(prev) || isBlocky(next) || hadBlankLine(prev, next);
}

/** Keep the author's paragraphing: was there an empty line between the two statements? */
function hadBlankLine(prev: AST.Statement, next: AST.Statement): boolean {
  const nextStart = next.leadingComments?.[0]?.span.start.line ?? next.span.start.line;
  const prevEnd = prev.trailingComment?.span.end.line ?? prev.span.end.line;
  return nextStart > prevEnd + 1;
}

function trimTrailingBlank(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") end--;
  return lines.slice(0, end);
}

