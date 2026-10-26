import { DiagnosticBag } from "../diagnostics.js";
import {
  KEYWORDS,
  TokenType,
  type Comment,
  type MarkupAttribute,
  type MarkupChild,
  type MarkupHole,
  type MarkupTag,
  type SourcePosition,
  type TemplatePart,
  type Token,
} from "./Token.js";

export interface LexResult {
  tokens: Token[];
  comments: Comment[];
  diagnostics: DiagnosticBag;
}

/** Operators sorted longest-first so the scanner always takes the maximal munch. */
const OPERATORS: [string, TokenType][] = (
  [
    ["?.", TokenType.QuestionDot],
    ["??", TokenType.QuestionQuestion],
    ["|>", TokenType.Pipe],
    ["->", TokenType.Arrow],
    ["=>", TokenType.FatArrow],
    ["..", TokenType.DotDot],
    ["==", TokenType.EqualEqual],
    ["!=", TokenType.BangEqual],
    ["<=", TokenType.LessEqual],
    [">=", TokenType.GreaterEqual],
    ["&&", TokenType.AndAnd],
    ["||", TokenType.OrOr],
    ["+=", TokenType.PlusEqual],
    ["-=", TokenType.MinusEqual],
    ["*=", TokenType.StarEqual],
    ["/=", TokenType.SlashEqual],
    ["(", TokenType.LeftParen],
    [")", TokenType.RightParen],
    ["{", TokenType.LeftBrace],
    ["}", TokenType.RightBrace],
    ["[", TokenType.LeftBracket],
    ["]", TokenType.RightBracket],
    [",", TokenType.Comma],
    [".", TokenType.Dot],
    [":", TokenType.Colon],
    [";", TokenType.Semicolon],
    ["?", TokenType.Question],
    ["+", TokenType.Plus],
    ["-", TokenType.Minus],
    ["*", TokenType.Star],
    ["/", TokenType.Slash],
    ["%", TokenType.Percent],
    ["!", TokenType.Bang],
    ["=", TokenType.Equal],
    ["<", TokenType.Less],
    [">", TokenType.Greater],
  ] as [string, TokenType][]
).sort((a, b) => b[0].length - a[0].length);

const ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  "0": "\0",
  "\\": "\\",
  '"': '"',
  "'": "'",
  $: "$",
};

/**
 * Converts MK source text into a token stream.
 *
 * Newlines are significant statement terminators, except inside `( )` and `[ ]`,
 * where expressions may span lines freely. Comments are collected separately so the
 * code generator can carry them into the emitted TypeScript.
 */
export class Lexer {
  private pos = 0;
  private line = 1;
  private column = 1;
  private readonly tokens: Token[] = [];
  private readonly comments: Comment[] = [];
  /** Open brackets; newlines only count when the innermost one is `{` (or none). */
  private readonly groups: TokenType[] = [];
  readonly diagnostics = new DiagnosticBag();

  constructor(
    private readonly source: string,
    /** Position of `source[0]` within the enclosing file (used for template sub-lexing). */
    private readonly origin: SourcePosition = { line: 1, column: 1, offset: 0 },
  ) {
    this.line = origin.line;
    this.column = origin.column;
  }

  static tokenize(source: string): LexResult {
    return new Lexer(source).run();
  }

  run(): LexResult {
    while (!this.atEnd()) {
      this.scanToken();
    }
    this.pushNewline();
    const here = this.position();
    this.tokens.push({ type: TokenType.EOF, lexeme: "", span: { start: here, end: here } });
    return { tokens: this.tokens, comments: this.comments, diagnostics: this.diagnostics };
  }

  private scanToken(): void {
    const c = this.peek();

    if (c === "\n") {
      this.advance();
      this.pushNewline();
      return;
    }
    if (c === " " || c === "\t" || c === "\r" || c === "﻿") {
      this.advance();
      return;
    }
    if (c === "/" && this.peek(1) === "/") return this.lineComment();
    if (c === "/" && this.peek(1) === "*") return this.blockComment();
    if (isDigit(c)) return this.number();
    if (isIdentStart(c)) return this.identifier();
    if (c === '"') return this.string();
    if (c === "<" && isIdentStart(this.peek(1)) && this.markupAllowed()) return this.markup();

    for (const [text, type] of OPERATORS) {
      if (this.source.startsWith(text, this.pos)) {
        const start = this.position();
        for (let i = 0; i < text.length; i++) this.advance();
        this.trackGroup(type);
        this.push(type, text, start);
        return;
      }
    }

    const start = this.position();
    this.advance();
    this.diagnostics.error("MK1001", `unexpected character '${c}'`, { start, end: this.position() });
  }

  private trackGroup(type: TokenType): void {
    switch (type) {
      case TokenType.LeftParen:
      case TokenType.LeftBracket:
      case TokenType.LeftBrace:
        this.groups.push(type);
        break;
      case TokenType.RightParen:
      case TokenType.RightBracket:
      case TokenType.RightBrace:
        this.groups.pop();
        break;
    }
  }

  private pushNewline(): void {
    const top = this.groups[this.groups.length - 1];
    if (top === TokenType.LeftParen || top === TokenType.LeftBracket) return;
    const last = this.tokens[this.tokens.length - 1];
    if (!last || last.type === TokenType.Newline) return;
    const here = this.position();
    this.tokens.push({ type: TokenType.Newline, lexeme: "\n", span: { start: here, end: here } });
  }

  private lineComment(): void {
    const start = this.position();
    while (!this.atEnd() && this.peek() !== "\n") this.advance();
    const raw = this.source.slice(start.offset - this.origin.offset, this.pos);
    this.comments.push({ kind: "line", text: raw.slice(2).replace(/\r$/, ""), span: { start, end: this.position() } });
  }

  private blockComment(): void {
    const start = this.position();
    this.advance();
    this.advance();
    while (!this.atEnd() && !(this.peek() === "*" && this.peek(1) === "/")) this.advance();
    if (this.atEnd()) {
      this.diagnostics.error("MK1002", "unterminated block comment", { start, end: this.position() });
      return;
    }
    this.advance();
    this.advance();
    const raw = this.source.slice(start.offset - this.origin.offset, this.pos);
    this.comments.push({ kind: "block", text: raw.slice(2, -2), span: { start, end: this.position() } });
  }

  private number(): void {
    const start = this.position();
    let isFloat = false;

    if (this.peek() === "0" && (this.peek(1) === "x" || this.peek(1) === "X")) {
      this.advance();
      this.advance();
      while (isHexDigit(this.peek()) || this.peek() === "_") this.advance();
    } else {
      this.digits();
      // A `.` is a decimal point only when a digit follows; `0..10` is a range.
      if (this.peek() === "." && isDigit(this.peek(1))) {
        isFloat = true;
        this.advance();
        this.digits();
      }
      if ((this.peek() === "e" || this.peek() === "E") && (isDigit(this.peek(1)) || "+-".includes(this.peek(1)))) {
        isFloat = true;
        this.advance();
        if (this.peek() === "+" || this.peek() === "-") this.advance();
        this.digits();
      }
    }

    const lexeme = this.source.slice(start.offset - this.origin.offset, this.pos);
    const value = Number(lexeme.replaceAll("_", ""));
    if (Number.isNaN(value)) {
      this.diagnostics.error("MK1003", `invalid number literal '${lexeme}'`, { start, end: this.position() });
    }
    this.push(isFloat ? TokenType.Float : TokenType.Int, lexeme, start, value);
  }

  private digits(): void {
    while (isDigit(this.peek()) || (this.peek() === "_" && isDigit(this.peek(1)))) this.advance();
  }

  private identifier(): void {
    const start = this.position();
    while (isIdentPart(this.peek())) this.advance();
    const lexeme = this.source.slice(start.offset - this.origin.offset, this.pos);
    this.push(KEYWORDS.get(lexeme) ?? TokenType.Identifier, lexeme, start);
  }

  private string(): void {
    const start = this.position();
    this.advance(); // opening quote
    const parts: TemplatePart[] = [];
    let text = "";

    while (!this.atEnd() && this.peek() !== '"' && this.peek() !== "\n") {
      const c = this.peek();
      if (c === "\\") {
        text += this.escape();
      } else if (c === "$" && this.peek(1) === "{") {
        if (text) parts.push({ kind: "text", value: text });
        text = "";
        parts.push(this.interpolation());
      } else {
        text += c;
        this.advance();
      }
    }

    if (this.peek() !== '"') {
      this.diagnostics.error("MK1004", "unterminated string literal", { start, end: this.position() });
      return;
    }
    this.advance(); // closing quote

    const lexeme = this.source.slice(start.offset - this.origin.offset, this.pos);
    if (parts.length === 0) {
      this.push(TokenType.String, lexeme, start, text);
    } else {
      if (text) parts.push({ kind: "text", value: text });
      this.push(TokenType.Template, lexeme, start, parts);
    }
  }

  private escape(): string {
    const start = this.position();
    this.advance(); // backslash
    const c = this.peek();
    if (c in ESCAPES) {
      this.advance();
      return ESCAPES[c]!;
    }
    if (c === "u" && this.peek(1) === "{") {
      this.advance();
      this.advance();
      let hex = "";
      while (isHexDigit(this.peek())) hex += this.advance();
      if (this.peek() === "}" && hex.length > 0 && hex.length <= 6) {
        this.advance();
        return String.fromCodePoint(parseInt(hex, 16));
      }
    }
    this.diagnostics.error("MK1005", `invalid escape sequence '\\${c}'`, { start, end: this.position() });
    if (!this.atEnd() && c !== "\n") this.advance();
    return "";
  }

  /** Scans `${ ... }` and returns the raw expression source for the parser to sub-parse. */
  private interpolation(): TemplatePart {
    const open = this.position();
    this.advance(); // $
    this.advance(); // {
    const start = this.position();
    let depth = 1;
    while (!this.atEnd() && this.peek() !== "\n") {
      const c = this.peek();
      if (c === '"') {
        // Skip nested string literals so their braces don't count.
        this.advance();
        while (!this.atEnd() && this.peek() !== '"' && this.peek() !== "\n") {
          if (this.peek() === "\\") this.advance();
          this.advance();
        }
        if (this.peek() === '"') this.advance();
        continue;
      }
      if (c === "{") depth++;
      if (c === "}" && --depth === 0) break;
      this.advance();
    }
    if (depth !== 0) {
      this.diagnostics.error("MK1006", "unterminated '${' in string", { start: open, end: this.position() });
      return { kind: "expr", source: "", start };
    }
    const source = this.source.slice(start.offset - this.origin.offset, this.pos);
    this.advance(); // }
    if (!source.trim()) {
      this.diagnostics.error("MK1007", "empty interpolation '${}'", { start: open, end: this.position() });
    }
    return { kind: "expr", source, start };
  }

  // -------------------------------------------------------------------------
  // Markup: `<div class="x">Hello {name}</div>`
  // -------------------------------------------------------------------------

  /**
   * `<` starts markup only where an expression may begin (like the regex-vs-division rule in
   * JavaScript): after `=`, `(`, `,`, `return`, `=>`, a newline, ... — never after a value, so
   * `a < b` and `List<int>` are unaffected.
   */
  private markupAllowed(): boolean {
    const last = this.tokens[this.tokens.length - 1];
    if (!last) return true;
    return MARKUP_PRECEDERS.has(last.type);
  }

  private markup(): void {
    const start = this.position();
    const tree = this.markupElement();
    const lexeme = this.source.slice(start.offset - this.origin.offset, this.pos);
    if (tree) this.push(TokenType.Markup, lexeme, start, tree);
  }

  private markupElement(): MarkupTag | undefined {
    const start = this.position();
    this.advance(); // <
    const tag = this.readWhile((c) => isIdentPart(c) || c === "-" || c === "." || c === ":");
    const attributes: MarkupAttribute[] = [];
    const fail = (message: string) => {
      this.diagnostics.error("MK1010", message, { start, end: this.position() });
      return undefined;
    };

    for (;;) {
      this.skipMarkupSpace();
      if (this.atEnd()) return fail(`unterminated tag <${tag}>`);
      if (this.peek() === "/" && this.peek(1) === ">") {
        this.advance();
        this.advance();
        return { kind: "element", tag, attributes, children: [], span: { start, end: this.position() } };
      }
      if (this.peek() === ">") {
        this.advance();
        break;
      }
      const attrStart = this.position();
      const name = this.readWhile((c) => isIdentPart(c) || c === "-" || c === ":");
      if (!name) {
        this.advance();
        return fail(`unexpected character in tag <${tag}>`);
      }
      this.skipMarkupSpace();
      let value: MarkupAttribute["value"] = true;
      if (this.peek() === "=") {
        this.advance();
        this.skipMarkupSpace();
        if (this.peek() === '"') {
          this.advance();
          value = decodeEntities(this.readWhile((c) => c !== '"'));
          if (this.atEnd()) return fail(`unterminated attribute value in <${tag}>`);
          this.advance();
        } else if (this.peek() === "{") {
          const hole = this.markupHole();
          if (!hole) return undefined;
          value = hole;
        } else {
          return fail(`attribute '${name}' needs a "string" or {expression} value`);
        }
      }
      attributes.push({ name, value, span: { start: attrStart, end: this.position() } });
    }

    const children: MarkupChild[] = [];
    for (;;) {
      if (this.atEnd()) return fail(`<${tag}> is never closed; add </${tag}>`);
      if (this.peek() === "<" && this.peek(1) === "/") {
        this.advance();
        this.advance();
        const closing = this.readWhile((c) => isIdentPart(c) || c === "-" || c === "." || c === ":");
        this.skipMarkupSpace();
        if (this.peek() !== ">") return fail(`expected '>' after </${closing}`);
        this.advance();
        if (closing !== tag) return fail(`</${closing}> does not match <${tag}>`);
        break;
      }
      if (this.peek() === "<" && isIdentStart(this.peek(1))) {
        const child = this.markupElement();
        if (!child) return undefined;
        children.push(child);
      } else if (this.peek() === "{") {
        const hole = this.markupHole();
        if (!hole) return undefined;
        children.push(hole);
      } else {
        const text = normalizeMarkupText(this.readWhile((c) => c !== "<" && c !== "{"));
        if (text) children.push({ kind: "text", value: decodeEntities(text) });
      }
    }
    return { kind: "element", tag, attributes, children, span: { start, end: this.position() } };
  }

  /** `{ ... }` inside markup — balanced braces, may span lines, may contain nested markup. */
  private markupHole(): MarkupHole | undefined {
    const open = this.position();
    this.advance(); // {
    const start = this.position();
    let depth = 1;
    while (!this.atEnd()) {
      const c = this.peek();
      if (c === '"') {
        this.advance();
        while (!this.atEnd() && this.peek() !== '"') {
          if (this.peek() === "\\") this.advance();
          this.advance();
        }
        if (!this.atEnd()) this.advance();
        continue;
      }
      if (c === "{") depth++;
      if (c === "}" && --depth === 0) break;
      this.advance();
    }
    if (depth !== 0) {
      this.diagnostics.error("MK1011", "unterminated '{' in markup", { start: open, end: this.position() });
      return undefined;
    }
    const source = this.source.slice(start.offset - this.origin.offset, this.pos);
    this.advance(); // }
    return { kind: "expr", source, start };
  }

  private skipMarkupSpace(): void {
    while (!this.atEnd() && /\s/.test(this.peek())) this.advance();
  }

  private readWhile(test: (c: string) => boolean): string {
    const from = this.pos;
    while (!this.atEnd() && test(this.peek())) this.advance();
    return this.source.slice(from, this.pos);
  }

  private push(type: TokenType, lexeme: string, start: SourcePosition, value?: Token["value"]): void {
    this.tokens.push({ type, lexeme, value, span: { start, end: this.position() } });
  }

  private position(): SourcePosition {
    return { line: this.line, column: this.column, offset: this.origin.offset + this.pos };
  }

  private peek(ahead = 0): string {
    return this.source[this.pos + ahead] ?? "\0";
  }

  private advance(): string {
    const c = this.source[this.pos++]!;
    if (c === "\n") {
      this.line++;
      this.column = 1;
    } else {
      this.column++;
    }
    return c;
  }

  private atEnd(): boolean {
    return this.pos >= this.source.length;
  }
}

const MARKUP_PRECEDERS = new Set<TokenType>([
  TokenType.Newline, TokenType.LeftParen, TokenType.LeftBracket, TokenType.LeftBrace, TokenType.Comma,
  TokenType.Equal, TokenType.FatArrow, TokenType.Return, TokenType.Colon, TokenType.AndAnd,
  TokenType.OrOr, TokenType.QuestionQuestion, TokenType.Semicolon, TokenType.Pipe,
]);

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, name: string) => ENTITIES[name]!);
}

/** JSX whitespace rules: text spanning lines is trimmed per line and joined with single spaces. */
function normalizeMarkupText(text: string): string {
  if (!text.includes("\n")) return text;
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
}

function isDigit(c: string): boolean {
  return c >= "0" && c <= "9";
}

function isHexDigit(c: string): boolean {
  return isDigit(c) || (c >= "a" && c <= "f") || (c >= "A" && c <= "F");
}

function isIdentStart(c: string): boolean {
  return (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
}

function isIdentPart(c: string): boolean {
  return isIdentStart(c) || isDigit(c);
}
