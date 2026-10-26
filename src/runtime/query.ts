/**
 * Query predicate IR emitted by the MK compiler, plus its two interpreters:
 * a SQL compiler (parameterized, per dialect) and an in-memory evaluator.
 */

const IR = Symbol.for("mk.query.ir");

export type BinaryOp = "eq" | "ne" | "lt" | "lte" | "gt" | "gte" | "and" | "or" | "add" | "sub" | "mul" | "div" | "mod";
export type MatchMode = "startsWith" | "endsWith" | "contains";

export type Expr =
  | { [IR]: true; kind: "col"; name: string }
  | { [IR]: true; kind: "param"; value: unknown }
  | { [IR]: true; kind: "bin"; op: BinaryOp; left: Expr; right: Expr }
  | { [IR]: true; kind: "not"; expr: Expr }
  | { [IR]: true; kind: "neg"; expr: Expr }
  | { [IR]: true; kind: "in"; expr: Expr; values: unknown[] }
  | { [IR]: true; kind: "match"; mode: MatchMode; expr: Expr; pattern: unknown };

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

function node(e: DistributiveOmit<Expr, typeof IR>): Expr {
  return { [IR]: true, ...e } as Expr;
}

export function isExpr(value: unknown): value is Expr {
  return typeof value === "object" && value !== null && (value as Record<symbol, unknown>)[IR] === true;
}

/** Host values become bound parameters — never spliced into SQL text. */
function lift(value: unknown): Expr {
  return isExpr(value) ? value : node({ kind: "param", value });
}

const bin = (op: BinaryOp) => (left: unknown, right: unknown): Expr => node({ kind: "bin", op, left: lift(left), right: lift(right) });

/** Builders used by compiled `where` / `set` clauses. */
export const q = {
  col: (name: string): Expr => node({ kind: "col", name }),
  param: (value: unknown): Expr => node({ kind: "param", value }),
  eq: bin("eq"),
  ne: bin("ne"),
  lt: bin("lt"),
  lte: bin("lte"),
  gt: bin("gt"),
  gte: bin("gte"),
  and: bin("and"),
  or: bin("or"),
  add: bin("add"),
  sub: bin("sub"),
  mul: bin("mul"),
  div: bin("div"),
  mod: bin("mod"),
  not: (expr: unknown): Expr => node({ kind: "not", expr: lift(expr) }),
  neg: (expr: unknown): Expr => node({ kind: "neg", expr: lift(expr) }),
  in: (expr: unknown, values: Iterable<unknown>): Expr => node({ kind: "in", expr: lift(expr), values: [...values] }),
  startsWith: (expr: unknown, pattern: unknown): Expr => node({ kind: "match", mode: "startsWith", expr: lift(expr), pattern }),
  endsWith: (expr: unknown, pattern: unknown): Expr => node({ kind: "match", mode: "endsWith", expr: lift(expr), pattern }),
  contains: (expr: unknown, pattern: unknown): Expr => node({ kind: "match", mode: "contains", expr: lift(expr), pattern }),
};

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

export type Dialect = "sqlite" | "postgres";

export interface CompiledSQL {
  sql: string;
  params: unknown[];
}

const SQL_OPS: Record<BinaryOp, string> = {
  eq: "=",
  ne: "<>",
  lt: "<",
  lte: "<=",
  gt: ">",
  gte: ">=",
  and: "AND",
  or: "OR",
  add: "+",
  sub: "-",
  mul: "*",
  div: "/",
  mod: "%",
};

export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** Accumulates bound parameters while SQL text is built. */
export class SqlWriter {
  readonly params: unknown[] = [];
  constructor(readonly dialect: Dialect) {}

  param(value: unknown): string {
    this.params.push(this.dialect === "sqlite" ? toSqliteValue(value) : value);
    return this.dialect === "postgres" ? `$${this.params.length}` : "?";
  }

  expr(e: Expr): string {
    switch (e.kind) {
      case "col":
        return quoteIdent(e.name);
      case "param":
        return this.param(e.value);
      case "bin": {
        // `col == null` must be `IS NULL` in SQL; `= NULL` is never true.
        if ((e.op === "eq" || e.op === "ne") && isNullParam(e.right)) return `${this.expr(e.left)} IS ${e.op === "ne" ? "NOT " : ""}NULL`;
        if ((e.op === "eq" || e.op === "ne") && isNullParam(e.left)) return `${this.expr(e.right)} IS ${e.op === "ne" ? "NOT " : ""}NULL`;
        return `(${this.expr(e.left)} ${SQL_OPS[e.op]} ${this.expr(e.right)})`;
      }
      case "not":
        return `(NOT ${this.expr(e.expr)})`;
      case "neg":
        return `(-${this.expr(e.expr)})`;
      case "in":
        if (e.values.length === 0) return "(1 = 0)";
        return `${this.expr(e.expr)} IN (${e.values.map((v) => this.param(v)).join(", ")})`;
      case "match": {
        const text = String(e.pattern ?? "");
        if (this.dialect === "sqlite") {
          // GLOB is case-sensitive, matching the in-memory adapter and Postgres LIKE.
          const escaped = text.replace(/[*?[]/g, "[$&]");
          const pattern = e.mode === "startsWith" ? `${escaped}*` : e.mode === "endsWith" ? `*${escaped}` : `*${escaped}*`;
          return `${this.expr(e.expr)} GLOB ${this.param(pattern)}`;
        }
        const escaped = text.replace(/[\\%_]/g, "\\$&");
        const pattern = e.mode === "startsWith" ? `${escaped}%` : e.mode === "endsWith" ? `%${escaped}` : `%${escaped}%`;
        return `${this.expr(e.expr)} LIKE ${this.param(pattern)}`;
      }
    }
  }
}

function isNullParam(e: Expr): boolean {
  return e.kind === "param" && (e.value === null || e.value === undefined);
}

export function toSqliteValue(value: unknown): unknown {
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object" && value !== null && !(value instanceof Uint8Array)) return JSON.stringify(value);
  return value;
}

// ---------------------------------------------------------------------------
// In-memory evaluation (SQL semantics: comparisons with NULL are not true)
// ---------------------------------------------------------------------------

export type Row = Record<string, unknown>;

export function evaluate(e: Expr, row: Row): unknown {
  switch (e.kind) {
    case "col":
      return row[e.name] ?? null;
    case "param":
      return e.value ?? null;
    case "not": {
      const v = evaluate(e.expr, row);
      return v === null ? null : !v;
    }
    case "neg": {
      const v = evaluate(e.expr, row);
      return v === null ? null : -(v as number);
    }
    case "in": {
      const v = evaluate(e.expr, row);
      return v === null ? null : e.values.some((x) => x === v);
    }
    case "match": {
      const v = evaluate(e.expr, row);
      if (v === null) return null;
      const s = String(v);
      const p = String(e.pattern ?? "");
      return e.mode === "startsWith" ? s.startsWith(p) : e.mode === "endsWith" ? s.endsWith(p) : s.includes(p);
    }
    case "bin":
      return evaluateBinary(e, row);
  }
}

function evaluateBinary(e: Extract<Expr, { kind: "bin" }>, row: Row): unknown {
  if (e.op === "and") {
    const l = evaluate(e.left, row);
    if (l === false) return false;
    const r = evaluate(e.right, row);
    if (r === false) return false;
    return l === null || r === null ? null : true;
  }
  if (e.op === "or") {
    const l = evaluate(e.left, row);
    if (l === true) return true;
    const r = evaluate(e.right, row);
    if (r === true) return true;
    return l === null || r === null ? null : false;
  }
  if ((e.op === "eq" || e.op === "ne") && (isNullParam(e.left) || isNullParam(e.right))) {
    const other = evaluate(isNullParam(e.right) ? e.left : e.right, row);
    return e.op === "eq" ? other === null : other !== null;
  }
  const l = evaluate(e.left, row) as number;
  const r = evaluate(e.right, row) as number;
  if (l === null || r === null) return null;
  switch (e.op) {
    case "eq":
      return l === r;
    case "ne":
      return l !== r;
    case "lt":
      return l < r;
    case "lte":
      return l <= r;
    case "gt":
      return l > r;
    case "gte":
      return l >= r;
    case "add":
      return typeof l === "string" || typeof r === "string" ? `${l}${r}` : l + r;
    case "sub":
      return l - r;
    case "mul":
      return l * r;
    case "div":
      return l / r;
    case "mod":
      return l % r;
  }
}

/** SQLite ordering: NULLs first ascending, numbers before strings. */
export function compareValues(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return -1;
  if (b === null || b === undefined) return 1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "number") return -1;
  if (typeof b === "number") return 1;
  const x = String(a);
  const y = String(b);
  return x < y ? -1 : x > y ? 1 : 0;
}
