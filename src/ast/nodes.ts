import type { Comment, SourceSpan } from "../lexer/Token.js";

/**
 * The MK abstract syntax tree.
 *
 * Nodes are plain objects discriminated by `kind`. Fields marked "annotated by the
 * analyzer" are filled in during semantic analysis and consumed by the code generator.
 */

export interface NodeBase {
  span: SourceSpan;
}

export interface StatementBase extends NodeBase {
  leadingComments?: Comment[];
  trailingComment?: Comment;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** `int`, `List<User>`, `Buffer?` */
export interface TypeReference extends NodeBase {
  kind: "TypeReference";
  name: string;
  args: TypeNode[];
  optional: boolean;
}

/** `fn(int, string) -> bool` */
export interface FunctionType extends NodeBase {
  kind: "FunctionType";
  params: TypeNode[];
  returnType: TypeNode;
  optional: boolean;
}

export type TypeNode = TypeReference | FunctionType;

// ---------------------------------------------------------------------------
// Program & declarations
// ---------------------------------------------------------------------------

export interface Program extends NodeBase {
  kind: "Program";
  body: Statement[];
  /** Comments after the last statement. */
  trailingComments: Comment[];
}

export interface ImportSpecifier extends NodeBase {
  imported: string;
  local: string;
}

/**
 * `import { Router } from "https://..."`, `import utils from "./utils.mk"`,
 * `import * as path from "node:path"`.
 */
export interface ImportDeclaration extends StatementBase {
  kind: "ImportDeclaration";
  specifiers: ImportSpecifier[];
  defaultBinding?: ImportSpecifier;
  namespaceBinding?: ImportSpecifier;
  source: string;
  sourceSpan: SourceSpan;
}

export interface Parameter extends NodeBase {
  name: string;
  type?: TypeNode;
  /** `consume data: Buffer` — the callee takes ownership of the argument. */
  consume: boolean;
  defaultValue?: Expression;
}

export interface FunctionDeclaration extends StatementBase {
  kind: "FunctionDeclaration";
  name: string;
  nameSpan: SourceSpan;
  params: Parameter[];
  returnType?: TypeNode;
  body: BlockStatement;
  exported: boolean;
  /** `view Name(...) { ... }`: a UI component whose last expression is its markup. */
  isView?: boolean;
  /** Annotated by the analyzer: the function (transitively) performs I/O. */
  isAsync?: boolean;
}

export interface EnumField extends NodeBase {
  name: string;
  type: TypeNode;
}

export interface EnumVariant extends NodeBase {
  name: string;
  fields: EnumField[];
}

/** `enum Shape { Circle(radius: float), Empty }` — a tagged union. */
export interface EnumDeclaration extends StatementBase {
  kind: "EnumDeclaration";
  name: string;
  nameSpan: SourceSpan;
  variants: EnumVariant[];
  exported: boolean;
}

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** `route GET "/todos/:id" (id: int) -> Todo? { ... }` — an HTTP endpoint. */
export interface RouteDeclaration extends StatementBase {
  kind: "RouteDeclaration";
  method: HttpMethod;
  path: string;
  pathSpan: SourceSpan;
  params: Parameter[];
  returnType?: TypeNode;
  body: BlockStatement;
}

/** `test "name" { ... }` — run by `mk test`, each with a fresh database. */
export interface TestDeclaration extends StatementBase {
  kind: "TestDeclaration";
  name: string;
  body: BlockStatement;
}

/** `assert expr` / `assert expr, "message"` */
export interface AssertStatement extends StatementBase {
  kind: "AssertStatement";
  test: Expression;
  message?: Expression;
}

export interface ModelField extends NodeBase {
  name: string;
  type: TypeNode;
}

/** `model User { id: int, name: string }` — a database table schema. */
export interface ModelDeclaration extends StatementBase {
  kind: "ModelDeclaration";
  name: string;
  nameSpan: SourceSpan;
  fields: ModelField[];
  exported: boolean;
}

/** `let x = 1` (immutable) or `var x = 1` (mutable). */
export interface VariableDeclaration extends StatementBase {
  kind: "VariableDeclaration";
  mutable: boolean;
  name: string;
  nameSpan: SourceSpan;
  type?: TypeNode;
  init: Expression;
  exported: boolean;
}

/** `signal count = 0` — a reactive cell. */
export interface SignalDeclaration extends StatementBase {
  kind: "SignalDeclaration";
  name: string;
  nameSpan: SourceSpan;
  type?: TypeNode;
  init: Expression;
  exported: boolean;
  /** Annotated by the analyzer: the initializer reads other signals, so it is a computed signal. */
  derived?: boolean;
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

export interface BlockStatement extends StatementBase {
  kind: "BlockStatement";
  body: Statement[];
  /** Comments right before the closing brace. */
  danglingComments?: Comment[];
}

/** `effect { ... }` — re-runs whenever a signal it reads changes. */
export interface EffectStatement extends StatementBase {
  kind: "EffectStatement";
  body: BlockStatement;
  /** Annotated by the analyzer. */
  isAsync?: boolean;
}

export interface ReturnStatement extends StatementBase {
  kind: "ReturnStatement";
  value?: Expression;
}

export interface IfStatement extends StatementBase {
  kind: "IfStatement";
  test: Expression;
  consequent: BlockStatement;
  alternate?: BlockStatement | IfStatement;
}

export interface WhileStatement extends StatementBase {
  kind: "WhileStatement";
  test: Expression;
  body: BlockStatement;
}

/** `for item in items { }` / `for i in 0..10 { }` */
export interface ForStatement extends StatementBase {
  kind: "ForStatement";
  variable: string;
  variableSpan: SourceSpan;
  iterable: Expression;
  body: BlockStatement;
}

export interface BreakStatement extends StatementBase {
  kind: "BreakStatement";
}

export interface ContinueStatement extends StatementBase {
  kind: "ContinueStatement";
}

export interface ExpressionStatement extends StatementBase {
  kind: "ExpressionStatement";
  expression: Expression;
}

export type Statement =
  | ImportDeclaration
  | FunctionDeclaration
  | EnumDeclaration
  | RouteDeclaration
  | TestDeclaration
  | AssertStatement
  | ModelDeclaration
  | VariableDeclaration
  | SignalDeclaration
  | BlockStatement
  | EffectStatement
  | ReturnStatement
  | IfStatement
  | WhileStatement
  | ForStatement
  | BreakStatement
  | ContinueStatement
  | ExpressionStatement;

// ---------------------------------------------------------------------------
// Expressions
// ---------------------------------------------------------------------------

export interface NumberLiteral extends NodeBase {
  kind: "NumberLiteral";
  value: number;
  raw: string;
  isFloat: boolean;
}

export interface StringLiteral extends NodeBase {
  kind: "StringLiteral";
  value: string;
}

/** `"Hello ${name}!"` — `quasis.length === expressions.length + 1`. */
export interface TemplateLiteral extends NodeBase {
  kind: "TemplateLiteral";
  quasis: string[];
  expressions: Expression[];
}

export interface BooleanLiteral extends NodeBase {
  kind: "BooleanLiteral";
  value: boolean;
}

export interface NullLiteral extends NodeBase {
  kind: "NullLiteral";
}

/** How an identifier inside a query clause is interpreted. */
export type QueryRole = "column" | "host";

export interface Identifier extends NodeBase {
  kind: "Identifier";
  name: string;
  /** Annotated by the analyzer: inside a query, a table column or a host-language value. */
  queryRole?: QueryRole;
}

export interface ListLiteral extends NodeBase {
  kind: "ListLiteral";
  elements: Expression[];
}

export interface ObjectProperty extends NodeBase {
  key: string;
  value: Expression;
  shorthand: boolean;
}

export interface ObjectLiteral extends NodeBase {
  kind: "ObjectLiteral";
  properties: ObjectProperty[];
}

export type BinaryOperator =
  | "+" | "-" | "*" | "/" | "%"
  | "==" | "!=" | "<" | "<=" | ">" | ">="
  | "&&" | "||" | "??"
  | "in";

export interface BinaryExpression extends NodeBase {
  kind: "BinaryExpression";
  operator: BinaryOperator;
  left: Expression;
  right: Expression;
}

export interface UnaryExpression extends NodeBase {
  kind: "UnaryExpression";
  operator: "!" | "-";
  operand: Expression;
}

export type AssignmentOperator = "=" | "+=" | "-=" | "*=" | "/=";

export interface AssignmentExpression extends NodeBase {
  kind: "AssignmentExpression";
  operator: AssignmentOperator;
  target: Identifier | MemberExpression | IndexExpression;
  value: Expression;
}

export interface CallExpression extends NodeBase {
  kind: "CallExpression";
  callee: Expression;
  args: Expression[];
  /** Annotated by the analyzer: the call performs I/O and must be awaited. */
  await?: boolean;
  /** Annotated by the analyzer: calling a capitalized host class (`Map()`, `Router()`) emits `new`. */
  construct?: boolean;
  /** Written as `a |> f(b)`; stored as `f(a, b)`. */
  piped?: boolean;
}

export interface MemberExpression extends NodeBase {
  kind: "MemberExpression";
  object: Expression;
  property: string;
  propertySpan: SourceSpan;
  optional: boolean;
}

export interface IndexExpression extends NodeBase {
  kind: "IndexExpression";
  object: Expression;
  index: Expression;
}

/** `a..b` — half-open integer range. */
export interface RangeExpression extends NodeBase {
  kind: "RangeExpression";
  start: Expression;
  end: Expression;
}

/** `fn(x: int) => x * 2` or `fn(x) { ... }` */
export interface LambdaExpression extends NodeBase {
  kind: "LambdaExpression";
  params: Parameter[];
  returnType?: TypeNode;
  body: BlockStatement | Expression;
  /** Annotated by the analyzer. */
  isAsync?: boolean;
}

/** `consume buf` — transfers ownership; `buf` may not be used afterwards. */
export interface ConsumeExpression extends NodeBase {
  kind: "ConsumeExpression";
  argument: Expression;
}

/** `spawn work()` / `spawn { ... }` — starts a concurrent task without waiting for it. */
export interface SpawnExpression extends NodeBase {
  kind: "SpawnExpression";
  body: Expression | BlockStatement;
}

export interface ModelReference extends NodeBase {
  name: string;
}

export interface OrderByClause extends NodeBase {
  column: string;
  direction: "asc" | "desc";
}

export interface ColumnReference extends NodeBase {
  name: string;
}

/** `query [first|count] User where score >= min order by score desc limit 10 offset 5 select name, score` */
export interface QueryExpression extends NodeBase {
  kind: "QueryExpression";
  mode: "all" | "first" | "count";
  model: ModelReference;
  where?: Expression;
  orderBy: OrderByClause[];
  limit?: Expression;
  offset?: Expression;
  select?: ColumnReference[];
  /** `live query ...`: a signal that re-runs when its inputs or its table change. */
  live?: boolean;
  /** Annotated by the analyzer: wait for the first result (false inside views). */
  liveAwait?: boolean;
}

/** `insert User { name: "Ana", score: 90 }` */
export interface InsertExpression extends NodeBase {
  kind: "InsertExpression";
  model: ModelReference;
  value: ObjectLiteral;
}

export interface UpdateAssignment extends NodeBase {
  column: string;
  value: Expression;
}

/** `update User set score = score + 1 where id == userId` */
export interface UpdateExpression extends NodeBase {
  kind: "UpdateExpression";
  model: ModelReference;
  assignments: UpdateAssignment[];
  where?: Expression;
}

/** `delete User where status == "banned"` */
export interface DeleteExpression extends NodeBase {
  kind: "DeleteExpression";
  model: ModelReference;
  where?: Expression;
}

export type Pattern =
  | { kind: "WildcardPattern"; span: SourceSpan }
  | { kind: "LiteralPattern"; value: NumberLiteral | StringLiteral | BooleanLiteral | NullLiteral; span: SourceSpan }
  | { kind: "BindingPattern"; name: string; span: SourceSpan }
  | VariantPattern;

export interface VariantPattern {
  kind: "VariantPattern";
  /** Variant name (`Circle`, `Ok`); a qualifier like `Shape.` is dropped. */
  name: string;
  /** One sub-pattern per field: `Err(Invalid(reason))`, `Rect(w, _)`. */
  args: Pattern[];
  span: SourceSpan;
  /** Annotated by the analyzer: the field each argument matches, in order. */
  fieldNames?: string[];
}

export interface MatchArm extends NodeBase {
  pattern: Pattern;
  guard?: Expression;
  body: Expression | BlockStatement;
}

/** `match value { Circle(r) => ..., _ => ... }` */
export interface MatchExpression extends NodeBase {
  kind: "MatchExpression";
  subject: Expression;
  arms: MatchArm[];
}

/** `expr?` — unwraps `Ok(v)`, or returns the `Err` from the enclosing function. */
export interface TryExpression extends NodeBase {
  kind: "TryExpression";
  operand: Expression;
}

export interface MarkupText extends NodeBase {
  kind: "MarkupText";
  value: string;
}

export interface MarkupAttribute extends NodeBase {
  name: string;
  value: StringLiteral | Expression | true;
  /** Annotated by the analyzer for `on:` handlers that perform I/O. */
  isAsync?: boolean;
}

/** `<button on:click={n += 1}>Clicked {n} times</button>` */
export interface MarkupElement extends NodeBase {
  kind: "MarkupElement";
  tag: string;
  attributes: MarkupAttribute[];
  children: (MarkupText | MarkupElement | Expression)[];
  /** Annotated by the analyzer: the tag is a `view` component. */
  component?: boolean;
}

export type Expression =
  | MatchExpression
  | TryExpression
  | MarkupElement
  | NumberLiteral
  | StringLiteral
  | TemplateLiteral
  | BooleanLiteral
  | NullLiteral
  | Identifier
  | ListLiteral
  | ObjectLiteral
  | BinaryExpression
  | UnaryExpression
  | AssignmentExpression
  | CallExpression
  | MemberExpression
  | IndexExpression
  | RangeExpression
  | LambdaExpression
  | ConsumeExpression
  | SpawnExpression
  | QueryExpression
  | InsertExpression
  | UpdateExpression
  | DeleteExpression;

export type Node = Program | Statement | Expression | TypeNode;

/** Expressions that talk to the database. */
export type DatabaseExpression = QueryExpression | InsertExpression | UpdateExpression | DeleteExpression;

export function isDatabaseExpression(e: Expression): e is DatabaseExpression {
  return (
    e.kind === "QueryExpression" ||
    e.kind === "InsertExpression" ||
    e.kind === "UpdateExpression" ||
    e.kind === "DeleteExpression"
  );
}
