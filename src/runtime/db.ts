import {
  compareValues,
  evaluate,
  isExpr,
  q,
  quoteIdent,
  SqlWriter,
  type CompiledSQL,
  type Dialect,
  type Expr,
  type Row,
} from "./query.js";

/** Column descriptor: `int`, `float`, `string`, `bool` or `json`, with a trailing `?` when nullable. */
export type ColumnType = string;

/** A table schema. Compiled `model` declarations create one of these per model. */
export interface Model<T = Row> {
  readonly name: string;
  readonly fields?: Readonly<Record<string, ColumnType>>;
  /** Phantom: carries the row type. */
  readonly __row?: T;
}

export interface SelectSpec {
  model: Model<any>;
  where?: Expr;
  orderBy: [column: string, direction: "asc" | "desc"][];
  limit?: number;
  offset?: number;
  columns?: string[];
}

export type UpdateValues = Record<string, unknown>;

/** Storage backend. Implement this (or wrap a driver in `SqlAdapter`) to plug in any database. */
export interface Adapter {
  readonly name: string;
  select(spec: SelectSpec): Promise<Row[]>;
  count(spec: SelectSpec): Promise<number>;
  insert(model: Model<any>, values: Row): Promise<Row>;
  update(spec: SelectSpec, values: UpdateValues): Promise<number>;
  delete(spec: SelectSpec): Promise<number>;
  close?(): void | Promise<void>;
}

// ---------------------------------------------------------------------------
// SQL statement builders
// ---------------------------------------------------------------------------

export function selectSQL(spec: SelectSpec, dialect: Dialect): CompiledSQL {
  const w = new SqlWriter(dialect);
  const columns = spec.columns?.length ? spec.columns.map(quoteIdent).join(", ") : "*";
  let sql = `SELECT ${columns} FROM ${quoteIdent(spec.model.name)}`;
  if (spec.where) sql += ` WHERE ${stripOuterParens(w.expr(spec.where))}`;
  if (spec.orderBy.length) sql += ` ORDER BY ${spec.orderBy.map(([c, d]) => `${quoteIdent(c)} ${d.toUpperCase()}`).join(", ")}`;
  if (spec.limit !== undefined) sql += ` LIMIT ${w.param(spec.limit)}`;
  else if (spec.offset !== undefined && dialect === "sqlite") sql += " LIMIT -1";
  if (spec.offset !== undefined) sql += ` OFFSET ${w.param(spec.offset)}`;
  return { sql, params: w.params };
}

export function countSQL(spec: SelectSpec, dialect: Dialect): CompiledSQL {
  const w = new SqlWriter(dialect);
  let sql = `SELECT COUNT(*) AS "count" FROM ${quoteIdent(spec.model.name)}`;
  if (spec.where) sql += ` WHERE ${stripOuterParens(w.expr(spec.where))}`;
  return { sql, params: w.params };
}

export function insertSQL(model: Model<any>, values: Row, dialect: Dialect): CompiledSQL {
  const w = new SqlWriter(dialect);
  const keys = Object.keys(values).filter((k) => values[k] !== undefined);
  const sql = keys.length
    ? `INSERT INTO ${quoteIdent(model.name)} (${keys.map(quoteIdent).join(", ")}) VALUES (${keys.map((k) => w.param(values[k])).join(", ")}) RETURNING *`
    : `INSERT INTO ${quoteIdent(model.name)} DEFAULT VALUES RETURNING *`;
  return { sql, params: w.params };
}

export function updateSQL(spec: SelectSpec, values: UpdateValues, dialect: Dialect): CompiledSQL {
  const w = new SqlWriter(dialect);
  const set = Object.entries(values)
    .map(([k, v]) => `${quoteIdent(k)} = ${isExpr(v) ? w.expr(v) : w.param(v)}`)
    .join(", ");
  let sql = `UPDATE ${quoteIdent(spec.model.name)} SET ${set}`;
  if (spec.where) sql += ` WHERE ${stripOuterParens(w.expr(spec.where))}`;
  return { sql, params: w.params };
}

export function deleteSQL(spec: SelectSpec, dialect: Dialect): CompiledSQL {
  const w = new SqlWriter(dialect);
  let sql = `DELETE FROM ${quoteIdent(spec.model.name)}`;
  if (spec.where) sql += ` WHERE ${stripOuterParens(w.expr(spec.where))}`;
  return { sql, params: w.params };
}

function stripOuterParens(sql: string): string {
  if (!sql.startsWith("(") || !sql.endsWith(")")) return sql;
  let depth = 0;
  for (let i = 0; i < sql.length; i++) {
    if (sql[i] === "(") depth++;
    else if (sql[i] === ")" && --depth === 0 && i < sql.length - 1) return sql;
  }
  return sql.slice(1, -1);
}

// ---------------------------------------------------------------------------
// Adapters
// ---------------------------------------------------------------------------

/** Default adapter: tables live in process memory. Same semantics as SQL, including NULL handling. */
export class MemoryAdapter implements Adapter {
  readonly name = "memory";
  private readonly tables = new Map<string, Row[]>();
  private readonly nextId = new Map<string, number>();

  private table(name: string): Row[] {
    let rows = this.tables.get(name);
    if (!rows) this.tables.set(name, (rows = []));
    return rows;
  }

  private matching(spec: SelectSpec): Row[] {
    const where = spec.where;
    return this.table(spec.model.name).filter((row) => !where || evaluate(where, row) === true);
  }

  async select(spec: SelectSpec): Promise<Row[]> {
    let rows = this.matching(spec);
    if (spec.orderBy.length) {
      rows = [...rows].sort((a, b) => {
        for (const [column, direction] of spec.orderBy) {
          const c = compareValues(a[column], b[column]);
          if (c !== 0) return direction === "desc" ? -c : c;
        }
        return 0;
      });
    }
    const start = spec.offset ?? 0;
    rows = rows.slice(start, spec.limit === undefined ? undefined : start + spec.limit);
    const columns = spec.columns;
    return rows.map((row) => (columns?.length ? Object.fromEntries(columns.map((c) => [c, row[c] ?? null])) : { ...row }));
  }

  async count(spec: SelectSpec): Promise<number> {
    return this.matching(spec).length;
  }

  async insert(model: Model<any>, values: Row): Promise<Row> {
    let row: Row = { ...values };
    const hasId = !model.fields || "id" in model.fields;
    if (hasId) {
      const next = this.nextId.get(model.name) ?? 1;
      const id = row.id ?? next;
      this.nextId.set(model.name, Math.max(next, Number(id) + 1));
      const { id: _ignored, ...rest } = row;
      row = { id, ...rest };
    }
    for (const column of Object.keys(model.fields ?? {})) row[column] ??= null;
    this.table(model.name).push(row);
    return { ...row };
  }

  async update(spec: SelectSpec, values: UpdateValues): Promise<number> {
    const rows = this.matching(spec);
    for (const row of rows) {
      const before = { ...row };
      for (const [k, v] of Object.entries(values)) row[k] = isExpr(v) ? evaluate(v, before) : v;
    }
    return rows.length;
  }

  async delete(spec: SelectSpec): Promise<number> {
    const doomed = new Set(this.matching(spec));
    const rows = this.table(spec.model.name);
    this.tables.set(spec.model.name, rows.filter((r) => !doomed.has(r)));
    return doomed.size;
  }
}

/** Minimal driver surface for SQL databases. */
export interface SqlDriver {
  all(sql: string, params: unknown[]): Promise<Row[]> | Row[];
  run(sql: string, params: unknown[]): Promise<{ changes: number }> | { changes: number };
}

/** Runs compiled, parameterized SQL through any driver (Postgres, SQLite, ...). */
export class SqlAdapter implements Adapter {
  readonly name: string;

  constructor(
    readonly dialect: Dialect,
    protected readonly driver: SqlDriver,
  ) {
    this.name = dialect;
  }

  protected async prepare(_model: Model<any>): Promise<void> {}

  protected decode(model: Model<any>, row: Row): Row {
    const out: Row = {};
    for (const [k, v] of Object.entries(row)) {
      const type = model.fields?.[k]?.replace("?", "");
      out[k] = v === null ? null : type === "bool" ? Boolean(v) : type === "json" && typeof v === "string" ? JSON.parse(v) : v;
    }
    return out;
  }

  async select(spec: SelectSpec): Promise<Row[]> {
    await this.prepare(spec.model);
    const { sql, params } = selectSQL(spec, this.dialect);
    return (await this.driver.all(sql, params)).map((r) => this.decode(spec.model, r));
  }

  async count(spec: SelectSpec): Promise<number> {
    await this.prepare(spec.model);
    const { sql, params } = countSQL(spec, this.dialect);
    const [row] = await this.driver.all(sql, params);
    return Number(row?.count ?? 0);
  }

  async insert(model: Model<any>, values: Row): Promise<Row> {
    await this.prepare(model);
    const { sql, params } = insertSQL(model, values, this.dialect);
    const [row] = await this.driver.all(sql, params);
    return this.decode(model, row ?? values);
  }

  async update(spec: SelectSpec, values: UpdateValues): Promise<number> {
    await this.prepare(spec.model);
    const { sql, params } = updateSQL(spec, values, this.dialect);
    return (await this.driver.run(sql, params)).changes;
  }

  async delete(spec: SelectSpec): Promise<number> {
    await this.prepare(spec.model);
    const { sql, params } = deleteSQL(spec, this.dialect);
    return (await this.driver.run(sql, params)).changes;
  }
}

const SQLITE_TYPES: Record<string, string> = { int: "INTEGER", float: "REAL", string: "TEXT", bool: "INTEGER", json: "TEXT" };

function columnSQL(name: string, type: ColumnType): string {
  const nullable = type.endsWith("?");
  const base = type.replace("?", "");
  if (name === "id" && base === "int") return `${quoteIdent(name)} INTEGER PRIMARY KEY`;
  return `${quoteIdent(name)} ${SQLITE_TYPES[base] ?? "TEXT"}${nullable ? "" : " NOT NULL"}`;
}

export function createTableSQL(model: Model<any>, ifNotExists = true): string {
  const columns = Object.entries(model.fields ?? {}).map(([name, type]) => columnSQL(name, type));
  return `CREATE TABLE ${ifNotExists ? "IF NOT EXISTS " : ""}${quoteIdent(model.name)} (${columns.join(", ")})`;
}

const ZERO: Record<string, string> = { int: "0", float: "0", bool: "0", string: "''", json: "'null'" };

export interface MigrationPlan {
  statements: string[];
  warnings: string[];
}

interface SqliteDatabase {
  close(): void;
  exec(sql: string): void;
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}

/** SQLite through Node's built-in `node:sqlite` — no dependencies. Creates tables from model schemas. */
export class SqliteAdapter extends SqlAdapter {
  private readonly created = new Set<string>();

  private constructor(private readonly database: SqliteDatabase, driver: SqlDriver) {
    super("sqlite", driver);
  }

  /**
   * Brings the database schema in line with the models: creates missing tables and adds new
   * columns. Dropping columns is destructive and only happens with `allowDrop`.
   */
  migrate(models: Model<any>[], options: { allowDrop?: boolean; dryRun?: boolean } = {}): MigrationPlan {
    const plan: MigrationPlan = { statements: [], warnings: [] };
    for (const model of models) {
      if (!model.fields) continue;
      const existing = this.database.prepare(`PRAGMA table_info(${quoteIdent(model.name)})`).all() as { name: string; type: string }[];
      if (!existing.length) {
        plan.statements.push(createTableSQL(model, false));
        continue;
      }
      const have = new Map(existing.map((c) => [c.name, c.type.toUpperCase()]));
      for (const [name, type] of Object.entries(model.fields)) {
        const base = type.replace("?", "");
        const current = have.get(name);
        if (current === undefined) {
          const def = type.endsWith("?") ? "" : ` DEFAULT ${ZERO[base] ?? "NULL"}`;
          plan.statements.push(`ALTER TABLE ${quoteIdent(model.name)} ADD COLUMN ${columnSQL(name, type)}${def}`);
        } else if (current !== (SQLITE_TYPES[base] ?? "TEXT")) {
          plan.warnings.push(`${model.name}.${name} is ${current} in the database but '${type}' in the model; change it by hand`);
        }
      }
      for (const column of have.keys()) {
        if (column in model.fields) continue;
        if (options.allowDrop) plan.statements.push(`ALTER TABLE ${quoteIdent(model.name)} DROP COLUMN ${quoteIdent(column)}`);
        else plan.warnings.push(`${model.name}.${column} is no longer in the model (run with --allow-drop to remove it)`);
      }
    }
    if (!options.dryRun && plan.statements.length) {
      this.database.exec(`BEGIN; ${plan.statements.join("; ")}; COMMIT;`);
    }
    return plan;
  }

  static async open(path: string): Promise<SqliteAdapter> {
    const { DatabaseSync } = await import("node:sqlite");
    const database = new DatabaseSync(path);
    const plain = (row: unknown) => ({ ...(row as Row) });
    const driver: SqlDriver = {
      all: (sql, params) => database.prepare(sql).all(...(params as never[])).map(plain),
      run: (sql, params) => ({ changes: Number(database.prepare(sql).run(...(params as never[])).changes) }),
    };
    return new SqliteAdapter(database, driver);
  }

  protected override async prepare(model: Model<any>): Promise<void> {
    if (!model.fields || this.created.has(model.name)) return;
    this.database.exec(createTableSQL(model));
    this.created.add(model.name);
  }

  close(): void {
    this.database.close();
  }
}

// ---------------------------------------------------------------------------
// Query builder & database
// ---------------------------------------------------------------------------

type Columns<T> = Extract<keyof T, string>;

/** Fluent, parameterized query — compiled MK `query` expressions build one of these. */
export class QueryBuilder<T> {
  private readonly spec: SelectSpec;

  constructor(
    private readonly db: Database,
    model: Model<T>,
  ) {
    this.spec = { model, orderBy: [] };
  }

  where(predicate: Expr | boolean): this {
    const expr = isExpr(predicate) ? predicate : q.param(predicate);
    this.spec.where = this.spec.where ? q.and(this.spec.where, expr) : expr;
    return this;
  }

  orderBy(column: Columns<T>, direction: "asc" | "desc" = "asc"): this {
    this.spec.orderBy.push([column, direction]);
    return this;
  }

  limit(n: number): this {
    this.spec.limit = n;
    return this;
  }

  offset(n: number): this {
    this.spec.offset = n;
    return this;
  }

  select<K extends Columns<T>>(...columns: K[]): QueryBuilder<Pick<T, K>> {
    this.spec.columns = columns;
    return this as unknown as QueryBuilder<Pick<T, K>>;
  }

  async all(): Promise<T[]> {
    this.db.log("select", () => selectSQL(this.spec, "sqlite"));
    return (await (await this.db.adapter()).select(this.spec)) as T[];
  }

  async first(): Promise<T | null> {
    this.spec.limit = 1;
    const [row] = await this.all();
    return row ?? null;
  }

  async count(): Promise<number> {
    this.db.log("count", () => countSQL(this.spec, "sqlite"));
    return (await this.db.adapter()).count(this.spec);
  }

  async update(values: { [K in Columns<T>]?: T[K] | Expr }): Promise<number> {
    this.db.log("update", () => updateSQL(this.spec, values, "sqlite"));
    const changed = await (await this.db.adapter()).update(this.spec, values);
    if (changed) await this.db.changed(this.spec.model.name);
    return changed;
  }

  async delete(): Promise<number> {
    this.db.log("delete", () => deleteSQL(this.spec, "sqlite"));
    const changed = await (await this.db.adapter()).delete(this.spec);
    if (changed) await this.db.changed(this.spec.model.name);
    return changed;
  }

  /** The parameterized SQL this query compiles to. */
  toSQL(dialect: Dialect = "sqlite"): CompiledSQL {
    return selectSQL(this.spec, dialect);
  }
}

/**
 * Entry point for all database access. The backend is chosen lazily on first use:
 * `MK_DB=app.sqlite` → SQLite file, otherwise in-memory. `MK_SEED=seed.json` preloads rows
 * (`{ "User": [{ ... }] }`). `MK_DEBUG_SQL=1` logs every statement to stderr.
 */
export class Database {
  private current?: Promise<Adapter>;
  private readonly models = new Map<string, Model<any>>();
  private readonly listeners = new Map<string, Set<() => Promise<void>>>();

  /** Calls `fn` after every write to `table`; returns an unsubscribe function. */
  onChange(table: string, fn: () => Promise<void>): () => void {
    let set = this.listeners.get(table);
    if (!set) this.listeners.set(table, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }

  /** @internal Notifies live queries; resolves when they have refreshed. */
  async changed(table: string): Promise<void> {
    await Promise.all([...(this.listeners.get(table) ?? [])].map((fn) => fn()));
  }

  model<T>(name: string, fields?: Record<string, ColumnType>): Model<T> {
    const model: Model<T> = Object.freeze({ name, fields: fields ? Object.freeze({ ...fields }) : undefined });
    this.models.set(name, model);
    return model;
  }

  /** Replace the backend (e.g. `db.use(new SqlAdapter("postgres", driver))`). */
  use(adapter: Adapter): void {
    this.current = Promise.resolve(adapter);
  }

  adapter(): Promise<Adapter> {
    return (this.current ??= this.open());
  }

  from<T>(model: Model<T> | string): QueryBuilder<T> {
    return new QueryBuilder<T>(this, this.resolve(model));
  }

  async insert<T>(model: Model<T> | string, values: Partial<T>): Promise<T> {
    const m = this.resolve(model);
    this.log("insert", () => insertSQL(m, values as Row, "sqlite"));
    const row = (await (await this.adapter()).insert(m, values as Row)) as T;
    await this.changed(m.name);
    return row;
  }

  async close(): Promise<void> {
    if (!this.current) return;
    const adapter = await this.current;
    this.current = undefined;
    await adapter.close?.();
  }

  /** @internal */
  log(_op: string, compile: () => CompiledSQL): void {
    if (!env("MK_DEBUG_SQL")) return;
    const { sql, params } = compile();
    console.error(`[mk:sql] ${sql}${params.length ? `  -- ${JSON.stringify(params)}` : ""}`);
  }

  private resolve<T>(model: Model<T> | string): Model<T> {
    if (typeof model !== "string") return model;
    return (this.models.get(model) as Model<T> | undefined) ?? this.model<T>(model);
  }

  private async open(): Promise<Adapter> {
    const target = env("MK_DB");
    const adapter: Adapter = target && target !== ":memory:" ? await SqliteAdapter.open(target) : new MemoryAdapter();
    const seedFile = env("MK_SEED");
    if (seedFile) await this.seed(adapter, seedFile);
    return adapter;
  }

  private async seed(adapter: Adapter, file: string): Promise<void> {
    const { readFile } = await import("node:fs/promises");
    const data = JSON.parse(await readFile(file, "utf8")) as Record<string, Row[]>;
    for (const [table, rows] of Object.entries(data)) {
      const model = this.resolve(table);
      // Never duplicate seed rows into a persistent database.
      if (adapter.name !== "memory" && (await adapter.count({ model, orderBy: [] })) > 0) continue;
      for (const row of rows) await adapter.insert(model, row);
    }
  }
}

function env(name: string): string | undefined {
  return (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env[name];
}

export const db = new Database();
