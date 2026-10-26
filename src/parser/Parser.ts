import type * as AST from "../ast/nodes.js";
import { DiagnosticBag } from "../diagnostics.js";
import { Lexer } from "../lexer/Lexer.js";
import { TokenType, type Comment, type SourceSpan, type TemplatePart, type Token } from "../lexer/Token.js";

export interface ParseResult {
  program: AST.Program;
  diagnostics: DiagnosticBag;
}

/** Internal signal used to unwind to the nearest statement boundary after a syntax error. */
class ParseFailure extends Error {}

const MAX_ERRORS = 50;

const STATEMENT_KEYWORDS = new Set<TokenType>([
  TokenType.Fn, TokenType.Let, TokenType.Var, TokenType.Signal, TokenType.Effect,
  TokenType.Import, TokenType.Export, TokenType.Return, TokenType.If, TokenType.While,
  TokenType.For, TokenType.Break, TokenType.Continue,
]);

const ASSIGNMENT_OPERATORS = new Map<TokenType, AST.AssignmentOperator>([
  [TokenType.Equal, "="],
  [TokenType.PlusEqual, "+="],
  [TokenType.MinusEqual, "-="],
  [TokenType.StarEqual, "*="],
  [TokenType.SlashEqual, "/="],
]);

/**
 * Recursive-descent parser producing an MK AST.
 *
 * Precedence, lowest to highest:
 *   assignment  =  +=  -=  *=  /=      (right-assoc)
 *   ??
 *   ||
 *   &&
 *   ==  !=
 *   <  <=  >  >=  in
 *   ..                                  (non-assoc)
 *   +  -
 *   *  /  %
 *   !  -  consume  spawn                (prefix)
 *   call  .member  ?.member  [index]    (postfix)
 *   primary (literals, names, lambdas, query / insert / update / delete)
 */
export class Parser {
  private current = 0;
  private commentCursor = 0;
  /** When true, `{` ends the expression instead of starting an object literal (if/while/for heads). */
  private noBraceExpr = false;

  constructor(
    private readonly tokens: Token[],
    private readonly comments: Comment[],
    readonly diagnostics: DiagnosticBag = new DiagnosticBag(),
  ) {}

  static parse(source: string): ParseResult {
    const lexed = Lexer.tokenize(source);
    const parser = new Parser(lexed.tokens, lexed.comments, lexed.diagnostics);
    return { program: parser.parseProgram(), diagnostics: parser.diagnostics };
  }

  parseProgram(): AST.Program {
    const start = this.peek();
    const body: AST.Statement[] = [];
    this.skipNewlines();
    while (!this.check(TokenType.EOF) && this.diagnostics.items.length < MAX_ERRORS) {
      const stmt = this.statementWithRecovery(true);
      if (stmt) body.push(stmt);
      this.skipNewlines();
    }
    const trailingComments = this.comments.slice(this.commentCursor);
    this.commentCursor = this.comments.length;
    return { kind: "Program", body, trailingComments, span: this.spanFrom(start) };
  }

  // -------------------------------------------------------------------------
  // Statements
  // -------------------------------------------------------------------------

  private statementWithRecovery(topLevel: boolean): AST.Statement | undefined {
    const leading = this.takeCommentsBefore(this.peek().span.start.offset);
    try {
      const stmt = this.statement(topLevel);
      if (leading.length) stmt.leadingComments = leading;
      const trailing = this.comments[this.commentCursor];
      if (trailing && trailing.span.start.line === stmt.span.end.line && trailing.span.start.offset >= stmt.span.end.offset) {
        stmt.trailingComment = trailing;
        this.commentCursor++;
      }
      this.terminator(stmt);
      return stmt;
    } catch (e) {
      if (!(e instanceof ParseFailure)) throw e;
      this.synchronize();
      return undefined;
    }
  }

  private statement(topLevel: boolean): AST.Statement {
    const token = this.peek();
    switch (token.type) {
      case TokenType.Import:
        if (!topLevel) this.fail(token, "MK2010", "imports are only allowed at the top level of a module");
        return this.importDeclaration();
      case TokenType.Export:
        if (!topLevel) this.fail(token, "MK2011", "'export' is only allowed at the top level of a module");
        return this.exportDeclaration();
      case TokenType.Fn:
        if (this.peek(1).type === TokenType.Identifier) return this.functionDeclaration(false);
        break;
      case TokenType.Let:
      case TokenType.Var:
        return this.variableDeclaration(false);
      case TokenType.Signal:
        return this.signalDeclaration(false);
      case TokenType.Effect:
        return this.effectStatement();
      case TokenType.Return:
        return this.returnStatement();
      case TokenType.If:
        return this.ifStatement();
      case TokenType.While:
        return this.whileStatement();
      case TokenType.For:
        return this.forStatement();
      case TokenType.Break:
        this.advance();
        return { kind: "BreakStatement", span: token.span };
      case TokenType.Continue:
        this.advance();
        return { kind: "ContinueStatement", span: token.span };
      case TokenType.LeftBrace:
        return this.block();
      case TokenType.Identifier:
        if (this.isModelDeclarationStart()) return this.modelDeclaration(false);
        break;
    }
    const expression = this.expression();
    return { kind: "ExpressionStatement", expression, span: expression.span };
  }

  /** After a statement: newline, `;`, `}` or EOF. Statements ending in a block need no separator. */
  private terminator(stmt: AST.Statement): void {
    if (this.match(TokenType.Semicolon, TokenType.Newline)) {
      this.skipNewlines();
      return;
    }
    if (this.check(TokenType.RightBrace) || this.check(TokenType.EOF)) return;
    if (this.previous().type === TokenType.RightBrace && endsWithBlock(stmt)) return;
    this.fail(this.peek(), "MK2001", `expected a newline or ';' after statement, found ${describe(this.peek())}`);
  }

  private importDeclaration(): AST.ImportDeclaration {
    const start = this.advance(); // import
    const specifiers: AST.ImportSpecifier[] = [];
    let defaultBinding: AST.ImportSpecifier | undefined;
    let namespaceBinding: AST.ImportSpecifier | undefined;

    if (this.check(TokenType.Star)) {
      const star = this.advance();
      this.expectContextual("as", "expected 'as' after '*' in import");
      const name = this.expect(TokenType.Identifier, "expected a namespace name after 'as'");
      namespaceBinding = { imported: "*", local: name.lexeme, span: this.spanBetween(star, name) };
    } else {
      if (this.check(TokenType.Identifier) && !this.checkContextual("from")) {
        const name = this.advance();
        defaultBinding = { imported: "default", local: name.lexeme, span: name.span };
        if (!this.match(TokenType.Comma)) return this.finishImport(start, specifiers, defaultBinding, namespaceBinding);
      }
      this.expect(TokenType.LeftBrace, "expected '{', '*' or a name after 'import'");
      this.skipNewlines();
      while (!this.check(TokenType.RightBrace)) {
        const imported = this.expectName("expected an imported name");
        let local = imported;
        if (this.matchContextual("as")) local = this.expect(TokenType.Identifier, "expected a local name after 'as'");
        specifiers.push({ imported: imported.lexeme, local: local.lexeme, span: this.spanBetween(imported, local) });
        this.skipNewlines();
        if (!this.match(TokenType.Comma)) break;
        this.skipNewlines();
      }
      this.skipNewlines();
      this.expect(TokenType.RightBrace, "expected '}' to close the import list");
    }
    return this.finishImport(start, specifiers, defaultBinding, namespaceBinding);
  }

  private finishImport(
    start: Token,
    specifiers: AST.ImportSpecifier[],
    defaultBinding?: AST.ImportSpecifier,
    namespaceBinding?: AST.ImportSpecifier,
  ): AST.ImportDeclaration {
    this.expectContextual("from", "expected 'from' in import declaration");
    const source = this.expect(TokenType.String, "expected a module path or URL string after 'from'");
    return {
      kind: "ImportDeclaration",
      specifiers,
      defaultBinding,
      namespaceBinding,
      source: source.value as string,
      sourceSpan: source.span,
      span: this.spanFrom(start),
    };
  }

  private exportDeclaration(): AST.Statement {
    const start = this.advance(); // export
    let decl: AST.Statement;
    switch (this.peek().type) {
      case TokenType.Fn:
        decl = this.functionDeclaration(true);
        break;
      case TokenType.Let:
      case TokenType.Var:
        decl = this.variableDeclaration(true);
        break;
      case TokenType.Signal:
        decl = this.signalDeclaration(true);
        break;
      default:
        if (this.isModelDeclarationStart()) {
          decl = this.modelDeclaration(true);
          break;
        }
        this.fail(this.peek(), "MK2012", "expected 'fn', 'let', 'var', 'signal' or 'model' after 'export'");
    }
    decl.span = { start: start.span.start, end: decl.span.end };
    return decl;
  }

  private functionDeclaration(exported: boolean): AST.FunctionDeclaration {
    const start = this.advance(); // fn
    const name = this.expect(TokenType.Identifier, "expected a function name");
    const params = this.parameterList(true);
    const returnType = this.match(TokenType.Arrow) ? this.type() : undefined;
    const body = this.block();
    return {
      kind: "FunctionDeclaration",
      name: name.lexeme,
      nameSpan: name.span,
      params,
      returnType,
      body,
      exported,
      span: this.spanFrom(start),
    };
  }

  private parameterList(requireTypes: boolean): AST.Parameter[] {
    this.expect(TokenType.LeftParen, "expected '(' to start the parameter list");
    const params: AST.Parameter[] = [];
    while (!this.check(TokenType.RightParen)) {
      const start = this.peek();
      const consume = this.match(TokenType.Consume);
      const name = this.expect(TokenType.Identifier, "expected a parameter name");
      let type: AST.TypeNode | undefined;
      if (this.match(TokenType.Colon)) type = this.type();
      else if (requireTypes) this.fail(this.peek(), "MK2020", `parameter '${name.lexeme}' needs a type annotation, e.g. '${name.lexeme}: int'`);
      const defaultValue = this.match(TokenType.Equal) ? this.expression() : undefined;
      params.push({ name: name.lexeme, type, consume, defaultValue, span: this.spanFrom(start) });
      if (!this.match(TokenType.Comma)) break;
    }
    this.expect(TokenType.RightParen, "expected ')' to close the parameter list");
    return params;
  }

  private isModelDeclarationStart(): boolean {
    return (
      this.checkContextual("model") &&
      this.peek(1).type === TokenType.Identifier &&
      this.peek(2).type === TokenType.LeftBrace
    );
  }

  private modelDeclaration(exported: boolean): AST.ModelDeclaration {
    const start = this.advance(); // model
    const name = this.expect(TokenType.Identifier, "expected a model name");
    this.expect(TokenType.LeftBrace, "expected '{' after the model name");
    const fields: AST.ModelField[] = [];
    this.skipNewlines();
    while (!this.check(TokenType.RightBrace) && !this.check(TokenType.EOF)) {
      const field = this.expectName("expected a field name");
      this.expect(TokenType.Colon, `expected ':' after field '${field.lexeme}'`);
      const type = this.type();
      fields.push({ name: field.lexeme, type, span: this.spanFrom(field) });
      if (!this.match(TokenType.Comma) && !this.check(TokenType.Newline) && !this.check(TokenType.RightBrace)) {
        this.fail(this.peek(), "MK2021", "expected ',' or a newline between model fields");
      }
      this.skipNewlines();
    }
    this.expect(TokenType.RightBrace, "expected '}' to close the model");
    return { kind: "ModelDeclaration", name: name.lexeme, nameSpan: name.span, fields, exported, span: this.spanFrom(start) };
  }

  private variableDeclaration(exported: boolean): AST.VariableDeclaration {
    const start = this.advance(); // let | var
    const name = this.expect(TokenType.Identifier, `expected a variable name after '${start.lexeme}'`);
    const type = this.match(TokenType.Colon) ? this.type() : undefined;
    this.expect(TokenType.Equal, `expected '=' after '${name.lexeme}' — variables must be initialized`);
    const init = this.expression();
    return {
      kind: "VariableDeclaration",
      mutable: start.type === TokenType.Var,
      name: name.lexeme,
      nameSpan: name.span,
      type,
      init,
      exported,
      span: this.spanFrom(start),
    };
  }

  private signalDeclaration(exported: boolean): AST.SignalDeclaration {
    const start = this.advance(); // signal
    const name = this.expect(TokenType.Identifier, "expected a signal name");
    const type = this.match(TokenType.Colon) ? this.type() : undefined;
    this.expect(TokenType.Equal, `expected '=' after signal '${name.lexeme}'`);
    const init = this.expression();
    return { kind: "SignalDeclaration", name: name.lexeme, nameSpan: name.span, type, init, exported, span: this.spanFrom(start) };
  }

  private effectStatement(): AST.EffectStatement {
    const start = this.advance(); // effect
    const body = this.block();
    return { kind: "EffectStatement", body, span: this.spanFrom(start) };
  }

  private returnStatement(): AST.ReturnStatement {
    const start = this.advance(); // return
    const hasValue = !this.check(TokenType.Newline, TokenType.Semicolon, TokenType.RightBrace, TokenType.EOF);
    const value = hasValue ? this.expression() : undefined;
    return { kind: "ReturnStatement", value, span: this.spanFrom(start) };
  }

  private ifStatement(): AST.IfStatement {
    const start = this.advance(); // if
    const test = this.headExpression();
    const consequent = this.block();
    let alternate: AST.IfStatement["alternate"];
    if (this.peekPastNewlines().type === TokenType.Else) {
      this.skipNewlines();
      this.advance(); // else
      alternate = this.check(TokenType.If) ? this.ifStatement() : this.block();
    }
    return { kind: "IfStatement", test, consequent, alternate, span: this.spanFrom(start) };
  }

  private whileStatement(): AST.WhileStatement {
    const start = this.advance(); // while
    const test = this.headExpression();
    const body = this.block();
    return { kind: "WhileStatement", test, body, span: this.spanFrom(start) };
  }

  private forStatement(): AST.ForStatement {
    const start = this.advance(); // for
    const variable = this.expect(TokenType.Identifier, "expected a loop variable after 'for'");
    this.expect(TokenType.In, "expected 'in' after the loop variable");
    const iterable = this.headExpression();
    const body = this.block();
    return {
      kind: "ForStatement",
      variable: variable.lexeme,
      variableSpan: variable.span,
      iterable,
      body,
      span: this.spanFrom(start),
    };
  }

  private block(): AST.BlockStatement {
    const start = this.expect(TokenType.LeftBrace, `expected '{', found ${describe(this.peek())}`);
    const body: AST.Statement[] = [];
    this.skipNewlines();
    while (!this.check(TokenType.RightBrace) && !this.check(TokenType.EOF)) {
      const stmt = this.statementWithRecovery(false);
      if (stmt) body.push(stmt);
      this.skipNewlines();
    }
    const dangling = this.takeCommentsBefore(this.peek().span.start.offset);
    this.expect(TokenType.RightBrace, "expected '}' to close the block");
    const node: AST.BlockStatement = { kind: "BlockStatement", body, span: this.spanFrom(start) };
    if (dangling.length) node.danglingComments = dangling;
    return node;
  }

  // -------------------------------------------------------------------------
  // Expressions
  // -------------------------------------------------------------------------

  expression(): AST.Expression {
    return this.assignment();
  }

  /** Expression in an `if` / `while` / `for` head, where `{` opens the body. */
  private headExpression(): AST.Expression {
    const saved = this.noBraceExpr;
    this.noBraceExpr = true;
    try {
      return this.expression();
    } finally {
      this.noBraceExpr = saved;
    }
  }

  private assignment(): AST.Expression {
    const target = this.nullish();
    const operator = ASSIGNMENT_OPERATORS.get(this.peek().type);
    if (!operator) return target;
    const opToken = this.advance();
    if (target.kind !== "Identifier" && target.kind !== "MemberExpression" && target.kind !== "IndexExpression") {
      this.error(opToken.span, "MK2030", "invalid assignment target");
    }
    this.skipNewlines();
    const value = this.assignment();
    return {
      kind: "AssignmentExpression",
      operator,
      target: target as AST.AssignmentExpression["target"],
      value,
      span: this.join(target.span, value.span),
    };
  }

  private nullish(): AST.Expression {
    return this.binaryLeft(() => this.or(), [[TokenType.QuestionQuestion, "??"]]);
  }

  private or(): AST.Expression {
    return this.binaryLeft(() => this.and(), [[TokenType.OrOr, "||"]]);
  }

  private and(): AST.Expression {
    return this.binaryLeft(() => this.equality(), [[TokenType.AndAnd, "&&"]]);
  }

  private equality(): AST.Expression {
    return this.binaryLeft(() => this.comparison(), [
      [TokenType.EqualEqual, "=="],
      [TokenType.BangEqual, "!="],
    ]);
  }

  private comparison(): AST.Expression {
    return this.binaryLeft(() => this.range(), [
      [TokenType.Less, "<"],
      [TokenType.LessEqual, "<="],
      [TokenType.Greater, ">"],
      [TokenType.GreaterEqual, ">="],
      [TokenType.In, "in"],
    ]);
  }

  private range(): AST.Expression {
    const start = this.additive();
    if (!this.match(TokenType.DotDot)) return start;
    this.skipNewlines();
    const end = this.additive();
    return { kind: "RangeExpression", start, end, span: this.join(start.span, end.span) };
  }

  private additive(): AST.Expression {
    return this.binaryLeft(() => this.multiplicative(), [
      [TokenType.Plus, "+"],
      [TokenType.Minus, "-"],
    ]);
  }

  private multiplicative(): AST.Expression {
    return this.binaryLeft(() => this.unary(), [
      [TokenType.Star, "*"],
      [TokenType.Slash, "/"],
      [TokenType.Percent, "%"],
    ]);
  }

  private binaryLeft(next: () => AST.Expression, ops: [TokenType, AST.BinaryOperator][]): AST.Expression {
    let left = next();
    for (;;) {
      const op = ops.find(([type]) => this.check(type));
      if (!op) return left;
      this.advance();
      this.skipNewlines(); // a trailing operator continues the expression on the next line
      const right = next();
      left = { kind: "BinaryExpression", operator: op[1], left, right, span: this.join(left.span, right.span) };
    }
  }

  private unary(): AST.Expression {
    const token = this.peek();
    if (this.match(TokenType.Bang, TokenType.Minus)) {
      const operand = this.unary();
      return { kind: "UnaryExpression", operator: token.lexeme as "!" | "-", operand, span: this.join(token.span, operand.span) };
    }
    if (this.match(TokenType.Consume)) {
      const argument = this.unary();
      return { kind: "ConsumeExpression", argument, span: this.join(token.span, argument.span) };
    }
    if (this.match(TokenType.Spawn)) {
      const body = this.check(TokenType.LeftBrace) ? this.block() : this.unary();
      return { kind: "SpawnExpression", body, span: this.join(token.span, body.span) };
    }
    return this.postfix();
  }

  private postfix(): AST.Expression {
    let expr = this.primary();
    for (;;) {
      // Allow method chains that continue on the next line with a leading `.`
      if (this.check(TokenType.Newline) && [TokenType.Dot, TokenType.QuestionDot].includes(this.peekPastNewlines().type)) {
        this.skipNewlines();
      }
      if (this.match(TokenType.LeftParen)) {
        const args = this.withBraces(() => this.commaList(TokenType.RightParen, () => this.expression()));
        this.expect(TokenType.RightParen, "expected ')' after call arguments");
        expr = { kind: "CallExpression", callee: expr, args, span: this.spanFromSpan(expr.span) };
      } else if (this.check(TokenType.Dot) || this.check(TokenType.QuestionDot)) {
        const optional = this.advance().type === TokenType.QuestionDot;
        const name = this.expectName("expected a property name after '.'");
        expr = { kind: "MemberExpression", object: expr, property: name.lexeme, propertySpan: name.span, optional, span: this.spanFromSpan(expr.span) };
      } else if (this.match(TokenType.LeftBracket)) {
        const index = this.withBraces(() => this.expression());
        this.expect(TokenType.RightBracket, "expected ']' after index");
        expr = { kind: "IndexExpression", object: expr, index, span: this.spanFromSpan(expr.span) };
      } else {
        return expr;
      }
    }
  }

  private primary(): AST.Expression {
    const token = this.peek();
    switch (token.type) {
      case TokenType.Int:
      case TokenType.Float:
        this.advance();
        return { kind: "NumberLiteral", value: token.value as number, raw: token.lexeme, isFloat: token.type === TokenType.Float, span: token.span };
      case TokenType.String:
        this.advance();
        return { kind: "StringLiteral", value: token.value as string, span: token.span };
      case TokenType.Template:
        this.advance();
        return this.template(token);
      case TokenType.True:
      case TokenType.False:
        this.advance();
        return { kind: "BooleanLiteral", value: token.type === TokenType.True, span: token.span };
      case TokenType.Null:
        this.advance();
        return { kind: "NullLiteral", span: token.span };
      case TokenType.Identifier:
        if (this.isMutationStart()) return this.mutation();
        this.advance();
        return { kind: "Identifier", name: token.lexeme, span: token.span };
      case TokenType.LeftParen: {
        this.advance();
        const inner = this.withBraces(() => this.expression());
        this.expect(TokenType.RightParen, "expected ')' to close the parenthesized expression");
        return { ...inner, span: this.spanFrom(token) };
      }
      case TokenType.LeftBracket: {
        this.advance();
        const elements = this.withBraces(() => this.commaList(TokenType.RightBracket, () => this.expression()));
        this.expect(TokenType.RightBracket, "expected ']' to close the list");
        return { kind: "ListLiteral", elements, span: this.spanFrom(token) };
      }
      case TokenType.LeftBrace:
        if (!this.noBraceExpr) return this.objectLiteral();
        break;
      case TokenType.Fn:
        return this.lambda();
      case TokenType.Query:
        return this.query();
    }
    this.fail(token, "MK2002", `expected an expression, found ${describe(token)}`);
  }

  private template(token: Token): AST.TemplateLiteral {
    const quasis: string[] = [];
    const expressions: AST.Expression[] = [];
    let text = "";
    for (const part of token.value as TemplatePart[]) {
      if (part.kind === "text") {
        text += part.value;
        continue;
      }
      quasis.push(text);
      text = "";
      expressions.push(this.subExpression(part.source, part.start, token.span));
    }
    quasis.push(text);
    return { kind: "TemplateLiteral", quasis, expressions, span: token.span };
  }

  /** Parses the source of a `${...}` interpolation with positions mapped into the outer file. */
  private subExpression(source: string, start: AST.NodeBase["span"]["start"], fallback: SourceSpan): AST.Expression {
    const lexer = new Lexer(source, start);
    const lexed = lexer.run();
    this.diagnostics.items.push(...lexed.diagnostics.items);
    const sub = new Parser(lexed.tokens, [], this.diagnostics);
    try {
      const expr = sub.expression();
      sub.skipNewlines();
      if (!sub.check(TokenType.EOF)) sub.fail(sub.peek(), "MK2003", "unexpected tokens in string interpolation");
      return expr;
    } catch (e) {
      if (!(e instanceof ParseFailure)) throw e;
      return { kind: "NullLiteral", span: fallback };
    }
  }

  private objectLiteral(): AST.ObjectLiteral {
    const start = this.advance(); // {
    const properties: AST.ObjectProperty[] = [];
    this.skipNewlines();
    while (!this.check(TokenType.RightBrace) && !this.check(TokenType.EOF)) {
      const keyToken = this.check(TokenType.String) ? this.advance() : this.expectName("expected a property name");
      const key = keyToken.type === TokenType.String ? (keyToken.value as string) : keyToken.lexeme;
      if (this.match(TokenType.Colon)) {
        this.skipNewlines();
        const value = this.withBraces(() => this.expression());
        properties.push({ key, value, shorthand: false, span: this.join(keyToken.span, value.span) });
      } else {
        if (keyToken.type !== TokenType.Identifier) this.fail(this.peek(), "MK2040", `expected ':' after property '${key}'`);
        const value: AST.Identifier = { kind: "Identifier", name: key, span: keyToken.span };
        properties.push({ key, value, shorthand: true, span: keyToken.span });
      }
      this.skipNewlines();
      if (!this.match(TokenType.Comma)) break;
      this.skipNewlines();
    }
    this.skipNewlines();
    this.expect(TokenType.RightBrace, "expected '}' to close the object literal");
    return { kind: "ObjectLiteral", properties, span: this.spanFrom(start) };
  }

  private lambda(): AST.LambdaExpression {
    const start = this.advance(); // fn
    const params = this.parameterList(false);
    const returnType = this.match(TokenType.Arrow) ? this.type() : undefined;
    let body: AST.LambdaExpression["body"];
    if (this.match(TokenType.FatArrow)) {
      this.skipNewlines();
      body = this.expression();
    } else {
      body = this.withBraces(() => this.block());
    }
    return { kind: "LambdaExpression", params, returnType, body, span: this.spanFrom(start) };
  }

  // -------------------------------------------------------------------------
  // Database expressions
  // -------------------------------------------------------------------------

  private query(): AST.QueryExpression {
    const start = this.advance(); // query
    let mode: AST.QueryExpression["mode"] = "all";
    if ((this.checkContextual("first") || this.checkContextual("count")) && this.peek(1).type === TokenType.Identifier) {
      mode = this.advance().lexeme as "first" | "count";
    }
    const model = this.modelReference();
    const node: AST.QueryExpression = { kind: "QueryExpression", mode, model, orderBy: [], span: start.span };

    for (;;) {
      this.continueClauseOnNextLine();
      if (this.match(TokenType.Where)) {
        if (node.where) this.error(this.previous().span, "MK2050", "duplicate 'where' clause");
        node.where = this.clauseExpression();
      } else if (this.checkContextual("order")) {
        this.advance();
        this.expectContextual("by", "expected 'by' after 'order'");
        do {
          const column = this.expectName("expected a column name after 'order by'");
          let direction: "asc" | "desc" = "asc";
          if (this.checkContextual("asc") || this.checkContextual("desc")) direction = this.advance().lexeme as "asc" | "desc";
          node.orderBy.push({ column: column.lexeme, direction, span: this.spanFrom(column) });
        } while (this.match(TokenType.Comma));
      } else if (this.checkContextual("limit")) {
        this.advance();
        node.limit = this.clauseExpression();
      } else if (this.checkContextual("offset")) {
        this.advance();
        node.offset = this.clauseExpression();
      } else if (this.checkContextual("select")) {
        this.advance();
        node.select = [];
        do {
          const column = this.expectName("expected a column name after 'select'");
          node.select.push({ name: column.lexeme, span: column.span });
        } while (this.match(TokenType.Comma));
      } else {
        break;
      }
    }
    if (mode === "count" && (node.select || node.limit || node.offset)) {
      this.error(start.span, "MK2051", "'query count' cannot have 'select', 'limit' or 'offset' clauses");
    }
    node.span = this.spanFrom(start);
    return node;
  }

  /** Query clauses may continue on following lines: `query User\n  where ...\n  order by ...` */
  private continueClauseOnNextLine(): void {
    if (!this.check(TokenType.Newline)) return;
    let i = this.current;
    while (this.tokens[i]?.type === TokenType.Newline) i++;
    const next = this.tokens[i];
    const after = this.tokens[i + 1];
    if (!next || !after) return;
    const isClause =
      next.type === TokenType.Where ||
      (next.type === TokenType.Identifier &&
        ((next.lexeme === "order" && after.lexeme === "by") ||
          ((next.lexeme === "limit" || next.lexeme === "offset") && !ASSIGNMENT_OPERATORS.has(after.type) && after.type !== TokenType.Newline) ||
          (next.lexeme === "select" && after.type === TokenType.Identifier)));
    if (isClause) this.current = i;
  }

  /** Clause expressions bind tighter than assignment and never swallow a following `{`. */
  private clauseExpression(): AST.Expression {
    return this.nullish();
  }

  private modelReference(): AST.ModelReference {
    const name = this.expect(TokenType.Identifier, "expected a model name");
    return { name: name.lexeme, span: name.span };
  }

  /** `insert X {..}`, `update X set ..`, `delete X where ..` — the verb is a keyword only before a name. */
  private isMutationStart(): boolean {
    const verb = this.peek().lexeme;
    const next = this.peek(1);
    if (next.type !== TokenType.Identifier || next.span.start.line !== this.peek().span.start.line) return false;
    if (verb === "insert") return this.peek(2).type === TokenType.LeftBrace;
    if (verb === "update") return this.peek(2).lexeme === "set";
    return verb === "delete";
  }

  private mutation(): AST.Expression {
    const verb = this.advance();
    const model = this.modelReference();
    if (verb.lexeme === "insert") {
      if (!this.check(TokenType.LeftBrace)) this.fail(this.peek(), "MK2052", "expected '{ ... }' with the values to insert");
      const saved = this.noBraceExpr;
      this.noBraceExpr = false;
      const value = this.objectLiteral();
      this.noBraceExpr = saved;
      return { kind: "InsertExpression", model, value, span: this.spanFrom(verb) };
    }
    if (verb.lexeme === "update") {
      this.expectContextual("set", "expected 'set' after the model name");
      const assignments: AST.UpdateAssignment[] = [];
      do {
        const column = this.expectName("expected a column name");
        this.expect(TokenType.Equal, `expected '=' after column '${column.lexeme}'`);
        const value = this.clauseExpression();
        assignments.push({ column: column.lexeme, value, span: this.join(column.span, value.span) });
      } while (this.match(TokenType.Comma));
      this.continueClauseOnNextLine();
      const where = this.match(TokenType.Where) ? this.clauseExpression() : undefined;
      return { kind: "UpdateExpression", model, assignments, where, span: this.spanFrom(verb) };
    }
    this.continueClauseOnNextLine();
    const where = this.match(TokenType.Where) ? this.clauseExpression() : undefined;
    return { kind: "DeleteExpression", model, where, span: this.spanFrom(verb) };
  }

  // -------------------------------------------------------------------------
  // Types
  // -------------------------------------------------------------------------

  private type(): AST.TypeNode {
    const start = this.peek();
    if (this.match(TokenType.Fn)) {
      this.expect(TokenType.LeftParen, "expected '(' in function type");
      const params = this.commaList(TokenType.RightParen, () => this.type());
      this.expect(TokenType.RightParen, "expected ')' in function type");
      this.expect(TokenType.Arrow, "expected '->' and a return type in function type");
      const returnType = this.type();
      const optional = this.match(TokenType.Question);
      return { kind: "FunctionType", params, returnType, optional, span: this.spanFrom(start) };
    }
    const name = this.expect(TokenType.Identifier, `expected a type, found ${describe(start)}`);
    const args: AST.TypeNode[] = [];
    if (this.match(TokenType.Less)) {
      do args.push(this.type());
      while (this.match(TokenType.Comma));
      this.expect(TokenType.Greater, "expected '>' to close the type arguments");
    }
    const optional = this.match(TokenType.Question);
    return { kind: "TypeReference", name: name.lexeme, args, optional, span: this.spanFrom(start) };
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private commaList<T>(close: TokenType, item: () => T): T[] {
    const items: T[] = [];
    this.skipNewlines();
    while (!this.check(close) && !this.check(TokenType.EOF)) {
      items.push(item());
      this.skipNewlines();
      if (!this.match(TokenType.Comma)) break;
      this.skipNewlines();
    }
    return items;
  }

  /** Inside brackets, `{` is an object literal again even in an `if` head. */
  private withBraces<T>(fn: () => T): T {
    const saved = this.noBraceExpr;
    this.noBraceExpr = false;
    try {
      return fn();
    } finally {
      this.noBraceExpr = saved;
    }
  }

  private takeCommentsBefore(offset: number): Comment[] {
    const taken: Comment[] = [];
    while (this.commentCursor < this.comments.length && this.comments[this.commentCursor]!.span.start.offset < offset) {
      taken.push(this.comments[this.commentCursor++]!);
    }
    return taken;
  }

  private synchronize(): void {
    let depth = 0;
    while (!this.check(TokenType.EOF)) {
      const t = this.peek();
      if (t.type === TokenType.LeftBrace) depth++;
      if (t.type === TokenType.RightBrace) {
        if (depth === 0) return;
        depth--;
      }
      if (depth === 0 && (t.type === TokenType.Newline || t.type === TokenType.Semicolon)) {
        this.advance();
        return;
      }
      if (depth === 0 && STATEMENT_KEYWORDS.has(t.type) && this.current > 0 && this.previous().type === TokenType.Newline) return;
      this.advance();
    }
  }

  private skipNewlines(): void {
    while (this.check(TokenType.Newline)) this.advance();
  }

  private peekPastNewlines(): Token {
    let i = this.current;
    while (this.tokens[i]?.type === TokenType.Newline) i++;
    return this.tokens[i] ?? this.tokens[this.tokens.length - 1]!;
  }

  private peek(ahead = 0): Token {
    return this.tokens[Math.min(this.current + ahead, this.tokens.length - 1)]!;
  }

  private previous(): Token {
    return this.tokens[Math.max(0, this.current - 1)]!;
  }

  private advance(): Token {
    const token = this.peek();
    if (token.type !== TokenType.EOF) this.current++;
    return token;
  }

  private check(...types: TokenType[]): boolean {
    return types.includes(this.peek().type);
  }

  private match(...types: TokenType[]): boolean {
    if (!this.check(...types)) return false;
    this.advance();
    return true;
  }

  private checkContextual(word: string): boolean {
    const t = this.peek();
    return t.type === TokenType.Identifier && t.lexeme === word;
  }

  private matchContextual(word: string): boolean {
    if (!this.checkContextual(word)) return false;
    this.advance();
    return true;
  }

  private expectContextual(word: string, message: string): Token {
    if (this.checkContextual(word)) return this.advance();
    this.fail(this.peek(), "MK2004", `${message}, found ${describe(this.peek())}`);
  }

  private expect(type: TokenType, message: string): Token {
    if (this.check(type)) return this.advance();
    this.fail(this.peek(), "MK2005", message.includes("found") ? message : `${message}, found ${describe(this.peek())}`);
  }

  /** Identifier, or any keyword used as a property / field name (`obj.delete`, `{ in: 1 }`). */
  private expectName(message: string): Token {
    const t = this.peek();
    if (t.type === TokenType.Identifier || /^[A-Za-z_][A-Za-z0-9_]*$/.test(t.lexeme)) return this.advance();
    this.fail(t, "MK2006", `${message}, found ${describe(t)}`);
  }

  private error(span: SourceSpan, code: string, message: string): void {
    this.diagnostics.error(code, message, span);
  }

  private fail(token: Token, code: string, message: string): never {
    this.error(token.span, code, message);
    throw new ParseFailure(message);
  }

  private spanFrom(start: Token): SourceSpan {
    return { start: start.span.start, end: this.previous().span.end };
  }

  private spanFromSpan(start: SourceSpan): SourceSpan {
    return { start: start.start, end: this.previous().span.end };
  }

  private spanBetween(a: Token, b: Token): SourceSpan {
    return { start: a.span.start, end: b.span.end };
  }

  private join(a: SourceSpan, b: SourceSpan): SourceSpan {
    return { start: a.start, end: b.end };
  }
}

function endsWithBlock(stmt: AST.Statement): boolean {
  switch (stmt.kind) {
    case "FunctionDeclaration":
    case "ModelDeclaration":
    case "BlockStatement":
    case "EffectStatement":
    case "IfStatement":
    case "WhileStatement":
    case "ForStatement":
      return true;
    default:
      return false;
  }
}

function describe(token: Token): string {
  switch (token.type) {
    case TokenType.EOF:
      return "end of file";
    case TokenType.Newline:
      return "end of line";
    case TokenType.Identifier:
      return `identifier '${token.lexeme}'`;
    case TokenType.String:
    case TokenType.Template:
      return `string ${token.lexeme}`;
    case TokenType.Int:
    case TokenType.Float:
      return `number ${token.lexeme}`;
    default:
      return `'${token.lexeme}'`;
  }
}
