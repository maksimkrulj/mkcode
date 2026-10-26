/** Every token kind the MK lexer can produce. */
export enum TokenType {
  // Literals & names
  Identifier = "Identifier",
  Int = "Int",
  Float = "Float",
  String = "String",
  Template = "Template",
  /** A whole `<tag ...>...</tag>` element; its value is a {@link MarkupTag}. */
  Markup = "Markup",

  // Hard keywords
  Fn = "fn",
  Let = "let",
  Var = "var",
  Signal = "signal",
  Effect = "effect",
  Query = "query",
  Where = "where",
  Consume = "consume",
  Spawn = "spawn",
  Import = "import",
  Export = "export",
  Return = "return",
  If = "if",
  Else = "else",
  While = "while",
  For = "for",
  In = "in",
  Break = "break",
  Continue = "continue",
  True = "true",
  False = "false",
  Null = "null",
  Enum = "enum",
  Match = "match",
  Assert = "assert",

  // Punctuation
  LeftParen = "(",
  RightParen = ")",
  LeftBrace = "{",
  RightBrace = "}",
  LeftBracket = "[",
  RightBracket = "]",
  Comma = ",",
  Dot = ".",
  QuestionDot = "?.",
  Colon = ":",
  Semicolon = ";",
  Arrow = "->",
  FatArrow = "=>",
  DotDot = "..",
  Question = "?",

  // Operators
  Plus = "+",
  Minus = "-",
  Star = "*",
  Slash = "/",
  Percent = "%",
  Bang = "!",
  Equal = "=",
  EqualEqual = "==",
  BangEqual = "!=",
  Less = "<",
  LessEqual = "<=",
  Greater = ">",
  GreaterEqual = ">=",
  AndAnd = "&&",
  OrOr = "||",
  QuestionQuestion = "??",
  Pipe = "|>",
  PlusEqual = "+=",
  MinusEqual = "-=",
  StarEqual = "*=",
  SlashEqual = "/=",

  // Layout
  Newline = "Newline",
  EOF = "EOF",
}

export const KEYWORDS: ReadonlyMap<string, TokenType> = new Map([
  ["fn", TokenType.Fn],
  ["let", TokenType.Let],
  ["var", TokenType.Var],
  ["signal", TokenType.Signal],
  ["effect", TokenType.Effect],
  ["query", TokenType.Query],
  ["where", TokenType.Where],
  ["consume", TokenType.Consume],
  ["spawn", TokenType.Spawn],
  ["import", TokenType.Import],
  ["export", TokenType.Export],
  ["return", TokenType.Return],
  ["if", TokenType.If],
  ["else", TokenType.Else],
  ["while", TokenType.While],
  ["for", TokenType.For],
  ["in", TokenType.In],
  ["break", TokenType.Break],
  ["continue", TokenType.Continue],
  ["true", TokenType.True],
  ["false", TokenType.False],
  ["null", TokenType.Null],
  ["enum", TokenType.Enum],
  ["match", TokenType.Match],
  ["assert", TokenType.Assert],
]);

/**
 * Words that act as keywords only in specific positions (e.g. `order by` inside a
 * query, `model` at statement start). Everywhere else they are ordinary identifiers.
 */
export const CONTEXTUAL_KEYWORDS = [
  "model", "from", "as", "order", "by", "asc", "desc", "limit", "offset", "select",
  "first", "count", "insert", "update", "delete", "set", "live", "route", "test", "view",
] as const;

export interface SourcePosition {
  /** 1-based line. */
  line: number;
  /** 1-based column. */
  column: number;
  /** 0-based character offset into the source. */
  offset: number;
}

export interface SourceSpan {
  start: SourcePosition;
  end: SourcePosition;
}

/** A piece of a `"...${expr}..."` string: literal text, or embedded expression source. */
export type TemplatePart =
  | { kind: "text"; value: string }
  | { kind: "expr"; source: string; start: SourcePosition };

/** An embedded `{expression}` inside markup, sub-parsed later like a template interpolation. */
export interface MarkupHole {
  kind: "expr";
  source: string;
  start: SourcePosition;
}

export interface MarkupAttribute {
  name: string;
  /** `true` for a bare attribute (`<input disabled>`). */
  value: string | MarkupHole | true;
  span: SourceSpan;
}

export type MarkupChild = { kind: "text"; value: string } | MarkupHole | MarkupTag;

export interface MarkupTag {
  kind: "element";
  tag: string;
  attributes: MarkupAttribute[];
  children: MarkupChild[];
  span: SourceSpan;
}

export interface Token {
  type: TokenType;
  /** Exact source text of the token. */
  lexeme: string;
  /** Decoded value for literals (number, unescaped string, template parts, markup tree). */
  value?: number | string | TemplatePart[] | MarkupTag;
  span: SourceSpan;
}

export interface Comment {
  text: string;
  /** `line` for `// ...`, `block` for `/* ... *\/`. */
  kind: "line" | "block";
  span: SourceSpan;
}
