import type * as AST from "../ast/nodes.js";
import { isDatabaseExpression } from "../ast/nodes.js";
import { DiagnosticBag } from "../diagnostics.js";
import type { SourceSpan } from "../lexer/Token.js";
import { BUILTINS, type Builtin } from "./builtins.js";
import {
  ANY,
  BOOL,
  FLOAT,
  INT,
  NULL,
  STRING,
  VOID,
  isAssignable,
  isComparable,
  isNumeric,
  isUnknown,
  list,
  optional,
  typeToString,
  type Type,
} from "./types.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type SymbolKind =
  | "variable"
  | "parameter"
  | "loopVariable"
  | "signal"
  | "function"
  | "model"
  | "import"
  | "builtin";

export interface ParamInfo {
  name: string;
  consume: boolean;
  optional: boolean;
  type: Type;
}

/** One callable body: a declared function, lambda, effect, spawned task or computed signal. */
export interface FunctionInfo {
  name: string;
  params: ParamInfo[];
  returns: Type;
  /** Performs I/O itself (query, async builtin, foreign call). */
  directAsync: boolean;
  /** Performs I/O itself or through any callee — the fixpoint result. */
  isAsync: boolean;
  callees: Set<FunctionInfo>;
  /** Imported from another module; asyncness is already known. */
  fixed?: boolean;
}

export interface ModelInfo {
  name: string;
  /** `undefined` when the model was referenced without a `model` declaration. */
  fields?: Map<string, Type>;
  origin: "declared" | "implicit" | "imported" | "foreign";
}

export interface MKSymbol {
  name: string;
  kind: SymbolKind;
  type: Type;
  mutable: boolean;
  span: SourceSpan;
  exported: boolean;
  /** The body that owns this binding; reads from any other body are captures. */
  context?: Context;
  /** Loop nesting depth (within `context`) at the declaration. */
  loopDepth: number;
  consumeParam?: boolean;
  derived?: boolean;
  fn?: FunctionInfo;
  builtin?: Builtin;
  model?: ModelInfo;
  consumedAt?: SourceSpan;
  consumedBy?: Context;
  captures: { context: Context; span: SourceSpan }[];
}

export type ExportedSymbol =
  | { kind: "function"; isAsync: boolean; params: ParamInfo[]; returns: Type }
  | { kind: "signal"; derived: boolean; type: Type }
  | { kind: "variable"; type: Type }
  | { kind: "model"; fields?: Map<string, Type> };

/** What other MK modules can see when they import this one. */
export interface ModuleInterface {
  exports: Map<string, ExportedSymbol>;
}

export interface AnalyzerOptions {
  /** Interfaces of imported `.mk` modules, keyed by the import specifier as written. */
  resolveModule?: (specifier: string) => ModuleInterface | undefined;
}

export interface AnalysisResult {
  diagnostics: DiagnosticBag;
  /** What each identifier refers to (absent for query columns and unresolved names). */
  resolutions: Map<AST.Identifier, MKSymbol>;
  /** Every model the module declares or queries, in first-use order. */
  models: Map<string, ModelInfo>;
  interface: ModuleInterface;
  /** The `main` entry point, if the module declares one. */
  main?: FunctionInfo;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

type ContextKind = "module" | "function" | "lambda" | "effect" | "spawn" | "computed";

interface Context {
  kind: ContextKind;
  info: FunctionInfo;
  parent?: Context;
  /** Declared return type; `undefined` means unchecked. */
  returnType?: Type;
  loopDepth: number;
  readsSignal: boolean;
  /** Moves of the parent's variables made inside a `spawn` body (ownership moves into the task). */
  escapes: Map<MKSymbol, Move>;
}

interface Move {
  span: SourceSpan;
  /** `false` when consumed on only some paths. */
  certain: boolean;
}

type MoveState = Map<MKSymbol, Move>;

class Scope {
  readonly symbols = new Map<string, MKSymbol>();
  constructor(readonly parent: Scope | undefined) {}

  lookup(name: string): MKSymbol | undefined {
    return this.symbols.get(name) ?? this.parent?.lookup(name);
  }

  *visibleNames(): Generator<string> {
    yield* this.symbols.keys();
    if (this.parent) yield* this.parent.visibleNames();
  }
}

const OWNED_KINDS = new Set<SymbolKind>(["variable", "parameter", "loopVariable"]);
const VALUE_KINDS = new Set<SymbolKind>(["variable", "parameter", "loopVariable", "signal"]);
const STRING_MATCHERS = new Set(["startsWith", "endsWith", "contains"]);
const CONSTRUCTIBLE = new Set(["Map", "Set", "URL", "Error", "Date", "Promise"]);
const PRIMITIVES: Record<string, Type> = { int: INT, float: FLOAT, string: STRING, bool: BOOL, void: VOID, any: ANY };

/**
 * Semantic analysis for one MK module:
 *
 * - **Scopes & symbols** — resolves every name, reports undefined / duplicate bindings.
 * - **Gradual type checking** — literals, annotations, model fields and function signatures.
 * - **Ownership** — flow-sensitive tracking of `consume`: a consumed variable may not be
 *   read again on any path, in the same or a nested scope.
 * - **Implicit async** — builds a call graph, marks bodies that (transitively) perform I/O,
 *   and annotates the exact call sites that must be awaited.
 * - **Queries** — decides which names inside `where` are table columns vs. host values.
 */
export class Analyzer {
  private readonly diagnostics = new DiagnosticBag();
  private readonly resolutions = new Map<AST.Identifier, MKSymbol>();
  private readonly models = new Map<string, ModelInfo>();
  private readonly infos: FunctionInfo[] = [];
  private readonly fnNodes = new Map<AST.FunctionDeclaration, FunctionInfo>();
  private readonly callSites: { call: AST.CallExpression; target: FunctionInfo }[] = [];
  private readonly asyncNodes: { node: { isAsync?: boolean }; info: FunctionInfo }[] = [];
  private readonly derivedSignals: { node: AST.SignalDeclaration; info: FunctionInfo }[] = [];
  private readonly allSymbols: MKSymbol[] = [];
  private readonly lambdaInfos = new Map<AST.LambdaExpression, FunctionInfo>();
  /** Calls and queries inside parameter defaults: JavaScript can't `await` there. */
  private readonly defaultValueIO: (AST.CallExpression | AST.DatabaseExpression)[] = [];
  private inDefaultValue = false;
  private moves: MoveState = new Map();
  private scope!: Scope;
  private ctx!: Context;

  constructor(private readonly options: AnalyzerOptions = {}) {}

  static analyze(program: AST.Program, options?: AnalyzerOptions): AnalysisResult {
    return new Analyzer(options).analyze(program);
  }

  analyze(program: AST.Program): AnalysisResult {
    this.ctx = this.newContext("module", this.newInfo("<module>", [], ANY), undefined);
    const builtins = new Scope(undefined);
    for (const b of BUILTINS.values()) {
      builtins.symbols.set(b.name, this.symbol(b.name, "builtin", b.type, program.span, { builtin: b, context: undefined }));
    }
    this.scope = new Scope(builtins);
    const moduleScope = this.scope;

    this.declareHoisted(program.body);
    const deferred: AST.FunctionDeclaration[] = [];
    this.statements(program.body, deferred);
    // Function bodies are checked after the whole module so they can see every top-level binding.
    for (const fn of deferred) this.functionDeclaration(fn, false);

    this.inferAsync();
    this.checkCapturedConsumes();

    const main = moduleScope.symbols.get("main");
    return {
      diagnostics: this.diagnostics,
      resolutions: this.resolutions,
      models: this.models,
      interface: this.buildInterface(program, moduleScope),
      main: main?.kind === "function" ? main.fn : undefined,
    };
  }

  // -------------------------------------------------------------------------
  // Declarations
  // -------------------------------------------------------------------------

  /** Functions, models and imports are visible throughout their scope, before their declaration. */
  private declareHoisted(body: AST.Statement[]): void {
    for (const stmt of body) if (stmt.kind === "ModelDeclaration") this.declareModel(stmt);
    for (const stmt of body) if (stmt.kind === "ImportDeclaration") this.declareImport(stmt);
    for (const stmt of body) {
      if (stmt.kind !== "FunctionDeclaration") continue;
      const params = stmt.params.map((p) => this.paramInfo(p));
      const info = this.newInfo(stmt.name, params, stmt.returnType ? this.resolveType(stmt.returnType) : ANY);
      this.fnNodes.set(stmt, info);
      const type: Type = { kind: "fn", params: params.map((p) => p.type), returns: info.returns };
      this.declare(this.symbol(stmt.name, "function", type, stmt.nameSpan, { fn: info, exported: stmt.exported }));
    }
  }

  private declareModel(stmt: AST.ModelDeclaration): void {
    const fields = new Map<string, Type>();
    for (const field of stmt.fields) {
      if (fields.has(field.name)) this.error("MK3403", `duplicate field '${field.name}' in model '${stmt.name}'`, field.span);
      fields.set(field.name, this.resolveType(field.type));
    }
    const model: ModelInfo = { name: stmt.name, fields, origin: "declared" };
    this.models.set(stmt.name, model);
    this.declare(this.symbol(stmt.name, "model", { kind: "model", name: stmt.name }, stmt.nameSpan, { model, exported: stmt.exported }));
  }

  private declareImport(stmt: AST.ImportDeclaration): void {
    const iface = this.options.resolveModule?.(stmt.source);
    for (const binding of [stmt.defaultBinding, stmt.namespaceBinding]) {
      if (binding) this.declare(this.symbol(binding.local, "import", ANY, binding.span));
    }
    for (const spec of stmt.specifiers) {
      const exported = iface?.exports.get(spec.imported);
      if (iface && !exported) {
        this.error("MK3501", `module '${stmt.source}' has no export named '${spec.imported}'`, spec.span);
      }
      this.declare(exported ? this.importedSymbol(spec, exported) : this.symbol(spec.local, "import", ANY, spec.span));
    }
  }

  private importedSymbol(spec: AST.ImportSpecifier, exp: ExportedSymbol): MKSymbol {
    switch (exp.kind) {
      case "function": {
        const info: FunctionInfo = {
          name: spec.local,
          params: exp.params,
          returns: exp.returns,
          directAsync: exp.isAsync,
          isAsync: exp.isAsync,
          callees: new Set(),
          fixed: true,
        };
        const type: Type = { kind: "fn", params: exp.params.map((p) => p.type), returns: exp.returns };
        return this.symbol(spec.local, "function", type, spec.span, { fn: info });
      }
      case "signal":
        return this.symbol(spec.local, "signal", exp.type, spec.span, { derived: exp.derived, mutable: !exp.derived });
      case "variable":
        return this.symbol(spec.local, "variable", exp.type, spec.span);
      case "model": {
        const model: ModelInfo = { name: spec.imported, fields: exp.fields, origin: "imported" };
        this.models.set(spec.local, model);
        return this.symbol(spec.local, "model", { kind: "model", name: spec.local }, spec.span, { model });
      }
    }
  }

  private paramInfo(p: AST.Parameter): ParamInfo {
    return { name: p.name, consume: p.consume, optional: p.defaultValue !== undefined, type: p.type ? this.resolveType(p.type) : ANY };
  }

  private resolveType(node: AST.TypeNode): Type {
    let type: Type;
    if (node.kind === "FunctionType") {
      type = { kind: "fn", params: node.params.map((p) => this.resolveType(p)), returns: this.resolveType(node.returnType) };
    } else {
      const args = node.args.map((a) => this.resolveType(a));
      const arity = (n: number) => {
        if (args.length !== n) this.error("MK3120", `'${node.name}' expects ${n} type argument${n === 1 ? "" : "s"}, found ${args.length}`, node.span);
      };
      if (node.name in PRIMITIVES) {
        arity(0);
        type = PRIMITIVES[node.name]!;
      } else if (node.name === "List") {
        arity(1);
        type = list(args[0] ?? ANY);
      } else if (node.name === "Map") {
        arity(2);
        type = { kind: "map", key: args[0] ?? ANY, value: args[1] ?? ANY };
      } else if (node.name === "Task") {
        arity(1);
        type = { kind: "task", inner: args[0] ?? ANY };
      } else {
        const sym = this.scope.lookup(node.name);
        type = sym?.kind === "model" ? { kind: "model", name: node.name } : { kind: "named", name: node.name, args };
      }
    }
    return node.optional ? optional(type) : type;
  }

  // -------------------------------------------------------------------------
  // Statements — each returns `true` if it never completes normally (return/break/continue)
  // -------------------------------------------------------------------------

  private statements(body: AST.Statement[], deferred?: AST.FunctionDeclaration[]): boolean {
    let terminated = false;
    let warned = false;
    for (const stmt of body) {
      if (terminated && !warned) {
        this.diagnostics.warning("MK3601", "unreachable code", stmt.span);
        warned = true;
      }
      if (stmt.kind === "FunctionDeclaration" && deferred) {
        deferred.push(stmt);
        continue;
      }
      if (this.statement(stmt)) terminated = true;
    }
    return terminated;
  }

  private statement(stmt: AST.Statement): boolean {
    switch (stmt.kind) {
      case "ImportDeclaration":
      case "ModelDeclaration":
        return false;
      case "FunctionDeclaration":
        this.functionDeclaration(stmt, true);
        return false;
      case "VariableDeclaration":
        this.variableDeclaration(stmt);
        return false;
      case "SignalDeclaration":
        this.signalDeclaration(stmt);
        return false;
      case "BlockStatement":
        return this.block(stmt);
      case "EffectStatement": {
        const info = this.newInfo("<effect>", [], ANY);
        this.withContext("effect", info, undefined, () => this.block(stmt.body));
        this.asyncNodes.push({ node: stmt, info });
        return false;
      }
      case "ReturnStatement":
        return this.returnStatement(stmt);
      case "IfStatement":
        return this.ifStatement(stmt);
      case "WhileStatement":
        this.condition(stmt.test);
        this.loopBody(() => this.block(stmt.body));
        return false;
      case "ForStatement":
        this.forStatement(stmt);
        return false;
      case "BreakStatement":
      case "ContinueStatement":
        if (this.ctx.loopDepth === 0) {
          this.error("MK3404", `'${stmt.kind === "BreakStatement" ? "break" : "continue"}' outside of a loop`, stmt.span);
        }
        return true;
      case "ExpressionStatement":
        this.expr(stmt.expression);
        return false;
    }
  }

  private block(node: AST.BlockStatement): boolean {
    return this.withScope(() => this.blockBody(node));
  }

  /** Statements of a block in the current scope (function bodies share the parameter scope). */
  private blockBody(node: AST.BlockStatement): boolean {
    this.declareHoisted(node.body.filter((s) => s.kind === "FunctionDeclaration" || s.kind === "ModelDeclaration"));
    return this.statements(node.body);
  }

  private functionDeclaration(node: AST.FunctionDeclaration, nested: boolean): void {
    const info = this.fnNodes.get(node)!;
    const declared = node.returnType ? info.returns : undefined;
    this.withContext(
      "function",
      info,
      declared,
      () => {
        this.declareParams(node.params, info.params);
        const terminates = this.blockBody(node.body);
        if (declared && declared.kind !== "void" && declared.kind !== "any" && declared.kind !== "optional" && !terminates) {
          this.error("MK3105", `function '${node.name}' must return a value of type '${typeToString(declared)}' on every path`, node.nameSpan);
        }
      },
      nested,
    );
    this.asyncNodes.push({ node, info });
    if (node.name === "main" && !nested && node.params.some((p) => !p.defaultValue)) {
      this.diagnostics.warning("MK3602", "'main' is called without arguments; its parameters will be undefined", node.nameSpan);
    }
  }

  private declareParams(params: AST.Parameter[], infos: ParamInfo[]): void {
    params.forEach((p, i) => {
      const info = infos[i]!;
      if (p.defaultValue) {
        const saved = this.inDefaultValue;
        this.inDefaultValue = true;
        const t = this.expr(p.defaultValue);
        this.inDefaultValue = saved;
        if (!isAssignable(t, info.type)) {
          this.error("MK3104", `default value of type '${typeToString(t)}' is not assignable to parameter '${p.name}: ${typeToString(info.type)}'`, p.defaultValue.span);
        }
      }
      this.declare(this.symbol(p.name, "parameter", info.type, p.span, { consumeParam: p.consume }));
    });
  }

  private variableDeclaration(node: AST.VariableDeclaration): void {
    const initType = this.expr(node.init);
    const type = this.checkInitializer(node.name, node.type, initType, node.init);
    const sym = this.symbol(node.name, "variable", type, node.nameSpan, { mutable: node.mutable, exported: node.exported });
    // An immutable binding of a lambda is as good as a named function for async inference.
    if (!node.mutable && node.init.kind === "LambdaExpression") sym.fn = this.lambdaInfos.get(node.init);
    this.declare(sym);
  }

  private signalDeclaration(node: AST.SignalDeclaration): void {
    const info = this.newInfo(`<signal ${node.name}>`, [], ANY);
    let initType: Type = ANY;
    const computed = this.withContext("computed", info, undefined, () => {
      initType = this.expr(node.init);
      return this.ctx;
    });
    node.derived = computed.readsSignal;

    if (node.derived) {
      this.derivedSignals.push({ node, info });
    } else {
      // Evaluated once, eagerly: it is part of the enclosing body, not a closure.
      for (const callee of info.callees) this.ctx.info.callees.add(callee);
      this.ctx.info.directAsync ||= info.directAsync;
      for (const sym of this.allSymbols) sym.captures = sym.captures.filter((c) => c.context !== computed);
    }

    const type = this.checkInitializer(node.name, node.type, initType, node.init);
    this.declare(
      this.symbol(node.name, "signal", type, node.nameSpan, { mutable: !node.derived, derived: node.derived, exported: node.exported }),
    );
  }

  private checkInitializer(name: string, annotation: AST.TypeNode | undefined, initType: Type, init: AST.Expression): Type {
    if (initType.kind === "void") this.error("MK3109", `the initializer of '${name}' does not produce a value`, init.span);
    if (!annotation) return initType.kind === "null" ? ANY : initType;
    const declared = this.resolveType(annotation);
    if (!isAssignable(initType, declared)) {
      this.error("MK3104", `cannot assign a value of type '${typeToString(initType)}' to '${name}: ${typeToString(declared)}'`, init.span);
    }
    return declared;
  }

  private returnStatement(node: AST.ReturnStatement): boolean {
    if (this.ctx.kind === "module" || this.ctx.kind === "computed") {
      this.error("MK3405", "'return' outside of a function", node.span);
    }
    const expected = this.ctx.returnType;
    if (node.value) {
      const t = this.expr(node.value);
      if (expected?.kind === "void") {
        this.error("MK3106", "this function is declared to return nothing ('void')", node.value.span);
      } else if (expected && !isAssignable(t, expected)) {
        this.error("MK3104", `cannot return a value of type '${typeToString(t)}' from a function returning '${typeToString(expected)}'`, node.value.span);
      }
    } else if (expected && expected.kind !== "void" && expected.kind !== "any" && expected.kind !== "optional") {
      this.error("MK3107", `missing return value of type '${typeToString(expected)}'`, node.span);
    }
    return true;
  }

  private ifStatement(node: AST.IfStatement): boolean {
    this.condition(node.test);
    const before = this.moves;

    this.moves = new Map(before);
    const thenExits = this.block(node.consequent);
    const afterThen = this.moves;

    this.moves = new Map(before);
    let elseExits = false;
    if (node.alternate) elseExits = node.alternate.kind === "IfStatement" ? this.ifStatement(node.alternate) : this.block(node.alternate);
    const afterElse = this.moves;

    // A branch that returns doesn't flow into the code after the `if`.
    if (thenExits && !elseExits) this.moves = afterElse;
    else if (elseExits && !thenExits) this.moves = afterThen;
    else this.moves = mergeMoves(afterThen, afterElse);
    return thenExits && elseExits;
  }

  private forStatement(node: AST.ForStatement): void {
    const iterable = this.expr(node.iterable);
    let element: Type = ANY;
    if (iterable.kind === "list") element = iterable.element;
    else if (iterable.kind === "string") element = STRING;
    else if (!isUnknown(iterable) && iterable.kind !== "map") {
      this.error("MK3108", `cannot iterate over a value of type '${typeToString(iterable)}'`, node.iterable.span);
    }
    this.loopBody(() =>
      this.withScope(() => {
        this.declare(this.symbol(node.variable, "loopVariable", element, node.variableSpan));
        this.block(node.body);
      }),
    );
  }

  private loopBody(body: () => void): void {
    const before = this.moves;
    this.moves = new Map(before);
    this.ctx.loopDepth++;
    body();
    this.ctx.loopDepth--;
    // The body may run zero or more times.
    this.moves = mergeMoves(before, this.moves);
  }

  private condition(test: AST.Expression): void {
    const t = this.expr(test);
    if (!isUnknown(t) && t.kind !== "bool") {
      this.error("MK3103", `condition must be a 'bool', found '${typeToString(t)}'`, test.span);
    }
  }

  // -------------------------------------------------------------------------
  // Expressions
  // -------------------------------------------------------------------------

  private expr(node: AST.Expression): Type {
    if (this.inDefaultValue && (node.kind === "CallExpression" || isDatabaseExpression(node))) this.defaultValueIO.push(node);
    switch (node.kind) {
      case "NumberLiteral":
        return node.isFloat ? FLOAT : INT;
      case "StringLiteral":
        return STRING;
      case "TemplateLiteral":
        node.expressions.forEach((e) => this.expr(e));
        return STRING;
      case "BooleanLiteral":
        return BOOL;
      case "NullLiteral":
        return NULL;
      case "Identifier":
        return this.identifier(node);
      case "ListLiteral": {
        const types = node.elements.map((e) => this.expr(e));
        return list(types.find((t) => t.kind !== "any" && t.kind !== "null") ?? ANY);
      }
      case "ObjectLiteral":
        node.properties.forEach((p) => this.expr(p.value));
        return ANY;
      case "BinaryExpression":
        return this.binary(node);
      case "UnaryExpression":
        return this.unaryType(node, this.expr(node.operand));
      case "AssignmentExpression":
        return this.assignment(node);
      case "CallExpression":
        return this.call(node);
      case "MemberExpression":
        return this.member(node, this.expr(node.object));
      case "IndexExpression": {
        const object = this.expr(node.object);
        this.expr(node.index);
        if (object.kind === "list") return object.element;
        if (object.kind === "map") return object.value;
        if (object.kind === "string") return STRING;
        return ANY;
      }
      case "RangeExpression": {
        for (const [part, t] of [[node.start, this.expr(node.start)], [node.end, this.expr(node.end)]] as const) {
          if (!isUnknown(t) && t.kind !== "int") this.error("MK3113", `range bounds must be 'int', found '${typeToString(t)}'`, part.span);
        }
        return list(INT);
      }
      case "LambdaExpression":
        return this.lambda(node);
      case "ConsumeExpression":
        return this.consume(node);
      case "SpawnExpression":
        return this.spawn(node);
      case "QueryExpression":
        return this.query(node);
      case "InsertExpression":
        return this.insert(node);
      case "UpdateExpression":
        return this.update(node);
      case "DeleteExpression":
        return this.deleteExpr(node);
    }
  }

  private identifier(node: AST.Identifier): Type {
    const sym = this.lookup(node.name, node.span);
    if (!sym) return ANY;
    this.resolutions.set(node, sym);
    this.checkNotConsumed(sym, node.span);
    this.noteCapture(sym, node.span);
    if (sym.kind === "signal") this.ctx.readsSignal = true;
    if (sym.kind === "model") {
      this.error("MK3410", `model '${sym.name}' is not a value; use 'query ${sym.name}' to read rows`, node.span);
    }
    return sym.type;
  }

  private binary(node: AST.BinaryExpression): Type {
    const left = this.expr(node.left);
    let right: Type;
    if (node.operator === "&&" || node.operator === "||" || node.operator === "??") {
      // The right side runs only sometimes: a `consume` there is a "maybe" move.
      const before = this.moves;
      this.moves = new Map(before);
      right = this.expr(node.right);
      this.moves = mergeMoves(before, this.moves);
    } else {
      right = this.expr(node.right);
    }
    return this.binaryType(node, left, right);
  }

  private binaryType(node: AST.BinaryExpression, l: Type, r: Type): Type {
    const op = node.operator;
    const known = !isUnknown(l) && !isUnknown(r);
    const mismatch = () =>
      this.error("MK3101", `operator '${op}' cannot be applied to '${typeToString(l)}' and '${typeToString(r)}'`, node.span);

    switch (op) {
      case "+":
        if (l.kind === "string" || r.kind === "string") return STRING;
        if (isNumeric(l) && isNumeric(r)) return l.kind === "float" || r.kind === "float" ? FLOAT : INT;
        if (known) mismatch();
        return ANY;
      case "-":
      case "*":
      case "%":
        if (isNumeric(l) && isNumeric(r)) return l.kind === "float" || r.kind === "float" ? FLOAT : INT;
        if (known) mismatch();
        return isNumeric(l) || isNumeric(r) ? (l.kind === "float" || r.kind === "float" ? FLOAT : INT) : ANY;
      case "/":
        if (known && !(isNumeric(l) && isNumeric(r))) mismatch();
        return FLOAT;
      case "<":
      case "<=":
      case ">":
      case ">=":
        if (known && !((isNumeric(l) && isNumeric(r)) || (l.kind === "string" && r.kind === "string"))) mismatch();
        return BOOL;
      case "==":
      case "!=":
        if (!isComparable(l, r)) {
          this.error("MK3102", `comparing '${typeToString(l)}' with '${typeToString(r)}' is always ${op === "==" ? "false" : "true"}`, node.span);
        }
        return BOOL;
      case "&&":
      case "||":
        for (const [side, t] of [[node.left, l], [node.right, r]] as const) {
          if (!isUnknown(t) && t.kind !== "bool") this.error("MK3101", `operator '${op}' expects 'bool' operands, found '${typeToString(t)}'`, side.span);
        }
        return BOOL;
      case "??":
        return l.kind === "optional" ? (isAssignable(r, l.inner) ? l.inner : ANY) : l.kind === "null" ? r : l;
      case "in":
        if (!isUnknown(r) && r.kind !== "list" && r.kind !== "string" && r.kind !== "map") {
          this.error("MK3101", `'in' expects a list, string or map on the right, found '${typeToString(r)}'`, node.right.span);
        }
        return BOOL;
    }
  }

  private unaryType(node: AST.UnaryExpression, t: Type): Type {
    if (node.operator === "!") {
      if (!isUnknown(t) && t.kind !== "bool") this.error("MK3101", `operator '!' expects a 'bool', found '${typeToString(t)}'`, node.span);
      return BOOL;
    }
    if (!isUnknown(t) && !isNumeric(t)) this.error("MK3101", `operator '-' expects a number, found '${typeToString(t)}'`, node.span);
    return isNumeric(t) ? t : ANY;
  }

  private assignment(node: AST.AssignmentExpression): Type {
    const value = this.expr(node.value);
    const target = node.target;
    if (target.kind !== "Identifier") {
      const targetType = this.expr(target);
      if (node.operator === "=" && !isAssignable(value, targetType)) {
        this.error("MK3104", `cannot assign a value of type '${typeToString(value)}' to a target of type '${typeToString(targetType)}'`, node.value.span);
      }
      return value;
    }

    const sym = this.lookup(target.name, target.span);
    if (!sym) return ANY;
    this.resolutions.set(target, sym);
    if (node.operator !== "=") this.checkNotConsumed(sym, target.span);
    this.noteCapture(sym, target.span);

    switch (sym.kind) {
      case "variable":
        if (!sym.mutable) {
          this.error("MK3201", `cannot assign to '${sym.name}': it is declared with 'let'; use 'var' for a mutable variable`, target.span, [
            { message: `'${sym.name}' is declared here`, span: sym.span },
          ]);
        }
        break;
      case "signal":
        if (sym.derived) {
          this.error("MK3202", `cannot assign to derived signal '${sym.name}'; it is computed from other signals`, target.span, [
            { message: `'${sym.name}' is declared here`, span: sym.span },
          ]);
        }
        break;
      case "parameter":
      case "loopVariable":
        this.error("MK3201", `cannot assign to ${sym.kind === "parameter" ? "parameter" : "loop variable"} '${sym.name}'`, target.span);
        break;
      default:
        this.error("MK3203", `cannot assign to ${kindName(sym.kind)} '${sym.name}'`, target.span);
    }

    if (node.operator === "=") {
      if (!isAssignable(value, sym.type)) {
        this.error("MK3104", `cannot assign a value of type '${typeToString(value)}' to '${sym.name}: ${typeToString(sym.type)}'`, node.value.span);
      }
      // Reassigning a consumed `var` gives it a fresh, owned value.
      this.moves.delete(sym);
    } else {
      const op = node.operator[0] as AST.BinaryOperator;
      this.binaryType({ kind: "BinaryExpression", operator: op, left: target, right: node.value, span: node.span }, sym.type, value);
    }
    return value;
  }

  private call(node: AST.CallExpression): Type {
    const callee = node.callee;
    let target: FunctionInfo | undefined;
    let builtin: Builtin | undefined;
    let foreign = false;
    let result: Type = ANY;
    let calleeName = "function";

    if (callee.kind === "Identifier") {
      calleeName = callee.name;
      const sym = this.lookup(callee.name, callee.span);
      if (sym) {
        this.resolutions.set(callee, sym);
        this.checkNotConsumed(sym, callee.span);
        this.noteCapture(sym, callee.span);
        if (sym.kind === "signal") this.ctx.readsSignal = true;
        if (sym.fn) target = sym.fn;
        else if (sym.builtin) builtin = sym.builtin;
        else if (sym.kind === "import") foreign = true;
        else if (sym.kind === "model") this.error("MK3411", `model '${sym.name}' is not callable; use 'insert ${sym.name} { ... }'`, callee.span);
        if (sym.type.kind === "fn") result = sym.type.returns;
        const isClass = /^[A-Z]/.test(sym.name);
        if (isClass && (sym.kind === "import" || (builtin && CONSTRUCTIBLE.has(sym.name)))) {
          node.construct = true;
        } else if (builtin?.kind === "value") {
          this.error("MK3411", `'${sym.name}' is not callable`, callee.span);
        }
      }
    } else {
      const calleeType = this.expr(callee);
      if (calleeType.kind === "fn") result = calleeType.returns;
      const root = rootIdentifier(callee);
      if (root && this.resolutions.get(root)?.kind === "import") foreign = true;
    }

    const argTypes = node.args.map((a) => this.expr(a));

    if (target) {
      this.checkArity(node, calleeName, target.params.filter((p) => !p.optional).length, target.params.length);
      target.params.forEach((param, i) => {
        const arg = node.args[i];
        if (!arg) return;
        if (!isAssignable(argTypes[i]!, param.type)) {
          this.error("MK3110", `argument of type '${typeToString(argTypes[i]!)}' is not assignable to parameter '${param.name}: ${typeToString(param.type)}'`, arg.span);
        }
        if (param.consume) this.checkConsumingArgument(arg, param, calleeName);
      });
      this.ctx.info.callees.add(target);
      this.callSites.push({ call: node, target });
      return target.returns;
    }
    if (builtin) {
      if (builtin.kind === "function") this.checkArity(node, builtin.name, builtin.minArgs ?? 0, builtin.maxArgs);
      if (builtin.async) this.markAwait(node);
      return builtin.type.kind === "fn" ? builtin.type.returns : ANY;
    }
    // Calls into foreign (non-MK) modules may return promises; awaiting a plain value is harmless.
    if (foreign && !node.construct) this.markAwait(node);
    return result;
  }

  private markAwait(node: AST.CallExpression): void {
    node.await = true;
    this.ctx.info.directAsync = true;
  }

  private checkArity(node: AST.CallExpression, name: string, min: number, max: number | undefined): void {
    const n = node.args.length;
    if (n < min || (max !== undefined && n > max)) {
      const expected = max === undefined ? `at least ${min}` : min === max ? `${min}` : `${min} to ${max}`;
      this.error("MK3114", `'${name}' expects ${expected} argument${expected === "1" ? "" : "s"}, found ${n}`, node.span);
    }
  }

  /** Passing a variable to a `consume` parameter must be explicit: `f(consume buf)`. */
  private checkConsumingArgument(arg: AST.Expression, param: ParamInfo, fnName: string): void {
    if (arg.kind !== "Identifier") return;
    const sym = this.resolutions.get(arg);
    if (sym && OWNED_KINDS.has(sym.kind)) {
      this.error(
        "MK3010",
        `'${arg.name}' is passed to consuming parameter '${param.name}' of '${fnName}'; write 'consume ${arg.name}' to transfer ownership`,
        arg.span,
      );
    }
  }

  private member(node: AST.MemberExpression, objectType: Type): Type {
    const base = objectType.kind === "optional" ? objectType.inner : objectType;
    let result: Type = ANY;
    if (base.kind === "model") {
      const fields = this.models.get(base.name)?.fields;
      if (fields) {
        const field = fields.get(node.property);
        if (!field) this.error("MK3112", `model '${base.name}' has no field '${node.property}'`, node.propertySpan);
        result = field ?? ANY;
      }
    } else if ((base.kind === "list" || base.kind === "string") && node.property === "length") {
      result = INT;
    }
    return node.optional || objectType.kind === "optional" ? optional(result) : result;
  }

  private lambda(node: AST.LambdaExpression): Type {
    const params = node.params.map((p) => this.paramInfo(p));
    const declared = node.returnType ? this.resolveType(node.returnType) : undefined;
    const info = this.newInfo("<lambda>", params, declared ?? ANY);
    this.lambdaInfos.set(node, info);
    this.withContext("lambda", info, declared, () => {
      this.declareParams(node.params, params);
      if (node.body.kind === "BlockStatement") {
        this.blockBody(node.body);
      } else {
        const t = this.expr(node.body);
        if (declared && !isAssignable(t, declared)) {
          this.error("MK3104", `lambda returns '${typeToString(t)}' but is declared to return '${typeToString(declared)}'`, node.body.span);
        }
        if (!declared) info.returns = t;
      }
    });
    this.asyncNodes.push({ node, info });
    return { kind: "fn", params: params.map((p) => p.type), returns: info.returns };
  }

  private consume(node: AST.ConsumeExpression): Type {
    if (node.argument.kind !== "Identifier") {
      this.error("MK3003", "only a variable can be consumed (e.g. 'consume buf')", node.argument.span);
      return this.expr(node.argument);
    }
    const id = node.argument;
    const sym = this.lookup(id.name, id.span);
    if (!sym) return ANY;
    this.resolutions.set(id, sym);
    if (this.checkNotConsumed(sym, id.span)) return sym.type;

    if (sym.kind === "signal") {
      this.error("MK3004", `cannot consume signal '${sym.name}'; signals are shared reactive state`, id.span);
      return sym.type;
    }
    if (!OWNED_KINDS.has(sym.kind)) {
      this.error("MK3005", `cannot consume ${kindName(sym.kind)} '${sym.name}'`, id.span);
      return sym.type;
    }
    if (sym.kind === "parameter" && !sym.consumeParam) {
      this.error("MK3008", `cannot consume borrowed parameter '${sym.name}'; declare it as 'consume ${sym.name}: ${typeToString(sym.type)}' to take ownership`, id.span, [
        { message: `'${sym.name}' is declared here`, span: sym.span },
      ]);
      return sym.type;
    }

    // A spawned task runs exactly once, so it may take ownership of its parent's variables.
    const intoTask = sym.context !== this.ctx && this.ctx.kind === "spawn" && sym.context === this.ctx.parent;
    if (sym.context !== this.ctx && !intoTask) {
      this.error("MK3006", `cannot consume captured variable '${sym.name}' inside a closure; it may run more than once`, id.span, [
        { message: `'${sym.name}' is declared outside this closure`, span: sym.span },
      ]);
      return sym.type;
    }
    const loopDepth = intoTask ? this.ctx.parent!.loopDepth : this.ctx.loopDepth;
    if (sym.loopDepth < loopDepth) {
      this.error("MK3009", `cannot consume '${sym.name}' inside a loop; it would be consumed again on the next iteration`, id.span, [
        { message: `'${sym.name}' is declared outside the loop`, span: sym.span },
      ]);
      return sym.type;
    }

    const move: Move = { span: node.span, certain: true };
    this.moves.set(sym, move);
    if (intoTask) this.ctx.escapes.set(sym, move);
    if (!sym.consumedAt) {
      sym.consumedAt = node.span;
      sym.consumedBy = this.ctx;
    }
    return sym.type;
  }

  private spawn(node: AST.SpawnExpression): Type {
    const info = this.newInfo("<spawn>", [], ANY);
    let inner: Type = ANY;
    const escapes = this.withContext("spawn", info, undefined, () => {
      if (node.body.kind === "BlockStatement") this.block(node.body);
      else inner = this.expr(node.body);
      return this.ctx.escapes;
    });
    for (const [sym, move] of escapes) this.moves.set(sym, move);
    return { kind: "task", inner };
  }

  // -------------------------------------------------------------------------
  // Database expressions
  // -------------------------------------------------------------------------

  private query(node: AST.QueryExpression): Type {
    this.ctx.info.directAsync = true;
    const model = this.resolveModel(node.model);
    if (node.where) this.predicate(node.where, model, "where");
    for (const order of node.orderBy) this.checkColumn(model, order.column, order.span);
    for (const column of node.select ?? []) this.checkColumn(model, column.name, column.span);
    for (const clause of [node.limit, node.offset]) {
      if (!clause) continue;
      const t = this.expr(clause);
      if (!isUnknown(t) && t.kind !== "int") this.error("MK3305", `'limit' and 'offset' expect an 'int', found '${typeToString(t)}'`, clause.span);
    }
    const row: Type = node.select ? ANY : { kind: "model", name: node.model.name };
    if (node.mode === "count") return INT;
    if (node.mode === "first") return optional(row);
    return list(row);
  }

  private insert(node: AST.InsertExpression): Type {
    this.ctx.info.directAsync = true;
    const model = this.resolveModel(node.model);
    const given = new Set<string>();
    for (const prop of node.value.properties) {
      given.add(prop.key);
      const t = this.expr(prop.value);
      const field = this.checkColumn(model, prop.key, prop.span);
      if (field && !isAssignable(t, field)) {
        this.error("MK3104", `cannot insert a value of type '${typeToString(t)}' into '${model.name}.${prop.key}: ${typeToString(field)}'`, prop.value.span);
      }
    }
    for (const [name, type] of model.fields ?? []) {
      if (!given.has(name) && name !== "id" && type.kind !== "optional") {
        this.error("MK3304", `missing field '${name}' when inserting into '${model.name}'`, node.value.span);
      }
    }
    return { kind: "model", name: node.model.name };
  }

  private update(node: AST.UpdateExpression): Type {
    this.ctx.info.directAsync = true;
    const model = this.resolveModel(node.model);
    for (const a of node.assignments) {
      const field = this.checkColumn(model, a.column, a.span);
      const t = this.predicate(a.value, model, "set").type;
      if (field && !isAssignable(t, field)) {
        this.error("MK3104", `cannot set '${model.name}.${a.column}: ${typeToString(field)}' to a value of type '${typeToString(t)}'`, a.value.span);
      }
    }
    if (node.where) this.predicate(node.where, model, "where");
    else this.diagnostics.warning("MK3603", `'update ${model.name}' without 'where' changes every row`, node.span);
    return INT;
  }

  private deleteExpr(node: AST.DeleteExpression): Type {
    this.ctx.info.directAsync = true;
    const model = this.resolveModel(node.model);
    if (node.where) this.predicate(node.where, model, "where");
    else this.diagnostics.warning("MK3603", `'delete ${model.name}' without 'where' removes every row`, node.span);
    return INT;
  }

  private resolveModel(ref: AST.ModelReference): ModelInfo {
    const existing = this.models.get(ref.name);
    if (existing) return existing;
    const sym = this.scope.lookup(ref.name);
    if (sym?.kind === "model" && sym.model) return sym.model;
    if (sym?.kind === "import") {
      const model: ModelInfo = { name: ref.name, origin: "foreign" };
      this.models.set(ref.name, model);
      return model;
    }
    if (sym && sym.kind !== "builtin") {
      this.error("MK3302", `'${ref.name}' is a ${kindName(sym.kind)}, not a model`, ref.span);
    } else {
      this.diagnostics.warning(
        "MK3301",
        `model '${ref.name}' has no schema; its columns are not type-checked. Declare it with 'model ${ref.name} { ... }'`,
        ref.span,
      );
    }
    const model: ModelInfo = { name: ref.name, origin: "implicit" };
    this.models.set(ref.name, model);
    return model;
  }

  /** Returns the column's type, or `undefined` (after reporting) when the model has no such column. */
  private checkColumn(model: ModelInfo, column: string, span: SourceSpan): Type | undefined {
    if (!model.fields) return ANY;
    const type = model.fields.get(column);
    if (!type) {
      const hint = suggest(column, model.fields.keys());
      this.error("MK3303", `model '${model.name}' has no column '${column}'${hint ? ` — did you mean '${hint}'?` : ""}`, span);
    }
    return type;
  }

  /**
   * Checks a query predicate. Sub-expressions that reference columns must be translatable to SQL
   * (comparisons, boolean logic, arithmetic, `in`, string matching); everything else is a host
   * value that becomes a bound parameter.
   */
  private predicate(node: AST.Expression, model: ModelInfo, clause: string): { type: Type; column: boolean } {
    switch (node.kind) {
      case "Identifier": {
        node.queryRole = this.classify(node, model);
        if (node.queryRole === "column") return { type: model.fields?.get(node.name) ?? ANY, column: true };
        return { type: this.expr(node), column: false };
      }
      case "BinaryExpression": {
        const l = this.predicate(node.left, model, clause);
        const r = this.predicate(node.right, model, clause);
        const column = l.column || r.column;
        if (column && node.operator === "??") {
          this.error("MK3306", "'??' cannot be used with columns inside a query", node.span);
        }
        if (column && node.operator === "in" && r.column) {
          this.error("MK3306", "the right side of 'in' must be a list value, not a column", node.right.span);
        }
        return { type: this.binaryType(node, l.type, r.type), column };
      }
      case "UnaryExpression": {
        const o = this.predicate(node.operand, model, clause);
        return { type: this.unaryType(node, o.type), column: o.column };
      }
      case "CallExpression": {
        const callee = node.callee;
        if (
          callee.kind === "MemberExpression" &&
          callee.object.kind === "Identifier" &&
          STRING_MATCHERS.has(callee.property) &&
          this.classify(callee.object, model) === "column"
        ) {
          callee.object.queryRole = "column";
          const columnType = model.fields?.get(callee.object.name) ?? ANY;
          if (!isUnknown(columnType) && columnType.kind !== "string") {
            this.error("MK3307", `'${callee.property}' needs a string column, but '${callee.object.name}' is '${typeToString(columnType)}'`, callee.object.span);
          }
          if (node.args.length !== 1) this.error("MK3114", `'${callee.property}' expects 1 argument, found ${node.args.length}`, node.span);
          for (const arg of node.args) {
            const t = this.predicate(arg, model, clause);
            if (t.column) this.error("MK3306", `the argument of '${callee.property}' must be a value, not a column`, arg.span);
          }
          return { type: BOOL, column: true };
        }
        return { type: this.expr(node), column: false };
      }
      case "ConsumeExpression":
        this.error("MK3012", `'consume' is not allowed inside a query '${clause}' clause`, node.span);
        return { type: this.expr(node.argument), column: false };
      default:
        return { type: this.expr(node), column: false };
    }
  }

  /**
   * With a declared schema, field names are columns and shadow outer names (like SQL).
   * Without one, function-local names are host values and anything else is a column.
   */
  private classify(node: AST.Identifier, model: ModelInfo): AST.QueryRole {
    if (model.fields) return model.fields.has(node.name) ? "column" : "host";
    const sym = this.scope.lookup(node.name);
    if (!sym) return "column";
    // Signal initializers, effects and tasks belong to the function (or module) around them.
    let home = this.ctx;
    while (home.parent && (home.kind === "computed" || home.kind === "effect" || home.kind === "spawn")) home = home.parent;
    const moduleLevel = sym.context?.kind === "module";
    if (moduleLevel && home.kind !== "module" && VALUE_KINDS.has(sym.kind)) return "column";
    return "host";
  }

  // -------------------------------------------------------------------------
  // Ownership helpers
  // -------------------------------------------------------------------------

  /** Reports a read of a consumed variable; returns true if one was reported. */
  private checkNotConsumed(sym: MKSymbol, span: SourceSpan): boolean {
    const move = this.moves.get(sym);
    if (!move) return false;
    if (move.certain) {
      this.error("MK3001", `use of consumed variable '${sym.name}'`, span, [
        { message: `'${sym.name}' was consumed here and can no longer be used`, span: move.span },
      ]);
    } else {
      this.error("MK3002", `use of possibly-consumed variable '${sym.name}'`, span, [
        { message: `'${sym.name}' is consumed here on some paths`, span: move.span },
      ]);
    }
    return true;
  }

  private noteCapture(sym: MKSymbol, span: SourceSpan): void {
    if (OWNED_KINDS.has(sym.kind) && sym.context && sym.context !== this.ctx) {
      sym.captures.push({ context: this.ctx, span });
    }
  }

  /** A closure might run after the variable it captured was consumed — reject that statically. */
  private checkCapturedConsumes(): void {
    for (const sym of this.allSymbols) {
      if (!sym.consumedAt) continue;
      const capture = sym.captures.find((c) => c.context !== sym.consumedBy);
      if (!capture) continue;
      this.error("MK3007", `cannot consume '${sym.name}' because a function or closure also uses it`, sym.consumedAt, [
        { message: `'${sym.name}' is captured here and could be used after it was consumed`, span: capture.span },
      ]);
    }
  }

  // -------------------------------------------------------------------------
  // Implicit async
  // -------------------------------------------------------------------------

  /** Propagates "performs I/O" through the call graph to a fixpoint, then annotates the AST. */
  private inferAsync(): void {
    for (const info of this.infos) if (!info.fixed) info.isAsync = info.directAsync;
    let changed = true;
    while (changed) {
      changed = false;
      for (const info of this.infos) {
        if (info.isAsync || info.fixed) continue;
        for (const callee of info.callees) {
          if (callee.isAsync) {
            info.isAsync = true;
            changed = true;
            break;
          }
        }
      }
    }
    for (const { call, target } of this.callSites) call.await = target.isAsync;
    for (const { node, info } of this.asyncNodes) node.isAsync = info.isAsync;
    for (const node of this.defaultValueIO) {
      if (node.kind !== "CallExpression" || node.await) {
        this.error("MK3205", "a parameter default cannot perform I/O; load the value inside the function body instead", node.span);
      }
    }
    for (const { node, info } of this.derivedSignals) {
      if (info.isAsync) {
        this.error(
          "MK3204",
          `derived signal '${node.name}' cannot perform I/O; compute it inside an 'effect' and assign a plain signal instead`,
          node.init.span,
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Module interface
  // -------------------------------------------------------------------------

  private buildInterface(program: AST.Program, moduleScope: Scope): ModuleInterface {
    const exports = new Map<string, ExportedSymbol>();
    for (const stmt of program.body) {
      if (!("exported" in stmt) || !stmt.exported) continue;
      const sym = moduleScope.symbols.get(stmt.name);
      if (!sym) continue;
      switch (sym.kind) {
        case "function":
          exports.set(sym.name, { kind: "function", isAsync: sym.fn!.isAsync, params: sym.fn!.params, returns: sym.fn!.returns });
          break;
        case "signal":
          exports.set(sym.name, { kind: "signal", derived: !!sym.derived, type: sym.type });
          break;
        case "variable":
          exports.set(sym.name, { kind: "variable", type: sym.type });
          break;
        case "model":
          exports.set(sym.name, { kind: "model", fields: sym.model?.fields });
          break;
      }
    }
    return { exports };
  }

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  private withScope<T>(fn: () => T): T {
    const saved = this.scope;
    this.scope = new Scope(saved);
    try {
      return fn();
    } finally {
      this.scope = saved;
    }
  }

  /**
   * Runs `fn` inside a new body. Closures start from the current ownership state (they can't
   * read what is already consumed); top-level functions start fresh. Either way, moves made
   * inside the body don't leak out — except moves into a spawned task, returned via `escapes`.
   */
  private withContext<T>(kind: ContextKind, info: FunctionInfo, returnType: Type | undefined, fn: () => T, inheritMoves = true): T {
    const saved = { ctx: this.ctx, scope: this.scope, moves: this.moves, inDefaultValue: this.inDefaultValue };
    this.ctx = this.newContext(kind, info, saved.ctx);
    this.ctx.returnType = returnType;
    this.scope = new Scope(saved.scope);
    this.moves = inheritMoves ? new Map(saved.moves) : new Map();
    this.inDefaultValue = false;
    try {
      return fn();
    } finally {
      this.ctx = saved.ctx;
      this.scope = saved.scope;
      this.moves = saved.moves;
      this.inDefaultValue = saved.inDefaultValue;
    }
  }

  private newContext(kind: ContextKind, info: FunctionInfo, parent: Context | undefined): Context {
    return { kind, info, parent, loopDepth: 0, readsSignal: false, escapes: new Map() };
  }

  private newInfo(name: string, params: ParamInfo[], returns: Type): FunctionInfo {
    const info: FunctionInfo = { name, params, returns, directAsync: false, isAsync: false, callees: new Set() };
    this.infos.push(info);
    return info;
  }

  private symbol(name: string, kind: SymbolKind, type: Type, span: SourceSpan, extra: Partial<MKSymbol> = {}): MKSymbol {
    return {
      name,
      kind,
      type,
      span,
      mutable: false,
      exported: false,
      context: this.ctx,
      loopDepth: this.ctx.loopDepth,
      captures: [],
      ...extra,
    };
  }

  private declare(sym: MKSymbol): void {
    const existing = this.scope.symbols.get(sym.name);
    if (existing) {
      this.error("MK3402", `'${sym.name}' is already declared in this scope`, sym.span, [
        { message: "previous declaration", span: existing.span },
      ]);
      return;
    }
    this.scope.symbols.set(sym.name, sym);
    this.allSymbols.push(sym);
  }

  private lookup(name: string, span: SourceSpan): MKSymbol | undefined {
    const sym = this.scope.lookup(name);
    if (!sym) {
      const hint = suggest(name, this.scope.visibleNames());
      this.error("MK3401", `undefined name '${name}'${hint ? ` — did you mean '${hint}'?` : ""}`, span);
    }
    return sym;
  }

  private error(code: string, message: string, span: SourceSpan, notes?: { message: string; span?: SourceSpan }[]): void {
    this.diagnostics.error(code, message, span, notes);
  }
}

function mergeMoves(a: MoveState, b: MoveState): MoveState {
  const out: MoveState = new Map();
  for (const [sym, move] of a) out.set(sym, { span: move.span, certain: move.certain && b.get(sym)?.certain === true });
  for (const [sym, move] of b) if (!a.has(sym)) out.set(sym, { span: move.span, certain: false });
  return out;
}

function rootIdentifier(expr: AST.Expression): AST.Identifier | undefined {
  while (expr.kind === "MemberExpression" || expr.kind === "IndexExpression" || expr.kind === "CallExpression") {
    expr = expr.kind === "CallExpression" ? expr.callee : expr.object;
  }
  return expr.kind === "Identifier" ? expr : undefined;
}

function kindName(kind: SymbolKind): string {
  switch (kind) {
    case "loopVariable":
      return "loop variable";
    case "import":
      return "imported binding";
    case "builtin":
      return "built-in";
    default:
      return kind;
  }
}

/** Closest name within edit distance 2, for "did you mean" hints. */
function suggest(name: string, candidates: Iterable<string>): string | undefined {
  let best: string | undefined;
  let bestDistance = 3;
  for (const candidate of candidates) {
    if (candidate === name) continue;
    const d = editDistance(name, candidate);
    if (d < bestDistance) {
      bestDistance = d;
      best = candidate;
    }
  }
  return best;
}

function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return row[b.length]!;
}
