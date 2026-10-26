import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Lexer } from "../src/lexer/Lexer.js";
import { TokenType as T, type TemplatePart } from "../src/lexer/Token.js";

const types = (src: string) => Lexer.tokenize(src).tokens.map((t) => t.type);

describe("Lexer", () => {
  it("recognizes MK keywords", () => {
    const tokens = Lexer.tokenize("signal query consume where spawn import fn let var effect").tokens;
    assert.deepEqual(
      tokens.map((t) => t.type),
      [T.Signal, T.Query, T.Consume, T.Where, T.Spawn, T.Import, T.Fn, T.Let, T.Var, T.Effect, T.Newline, T.EOF],
    );
  });

  it("keeps contextual keywords as identifiers", () => {
    for (const word of ["order", "by", "desc", "limit", "model", "from", "insert", "select"]) {
      assert.equal(Lexer.tokenize(word).tokens[0]!.type, T.Identifier, word);
    }
  });

  it("tokenizes a signal declaration with positions", () => {
    const { tokens } = Lexer.tokenize("signal score = 100");
    assert.deepEqual(tokens.map((t) => t.type), [T.Signal, T.Identifier, T.Equal, T.Int, T.Newline, T.EOF]);
    assert.deepEqual(tokens[1]!.span.start, { line: 1, column: 8, offset: 7 });
    assert.equal(tokens[3]!.value, 100);
  });

  it("scans numbers: separators, floats, exponents, hex, and ranges", () => {
    const { tokens } = Lexer.tokenize("1_000 3.14 1e3 0xff 0..10");
    assert.deepEqual(
      tokens.slice(0, 7).map((t) => [t.type, t.value]),
      [
        [T.Int, 1000],
        [T.Float, 3.14],
        [T.Float, 1000],
        [T.Int, 255],
        [T.Int, 0],
        [T.DotDot, undefined],
        [T.Int, 10],
      ],
    );
  });

  it("uses maximal munch for operators", () => {
    assert.deepEqual(types("a >= b -> c => d ?. e ?? f != g"), [
      T.Identifier, T.GreaterEqual, T.Identifier, T.Arrow, T.Identifier, T.FatArrow, T.Identifier,
      T.QuestionDot, T.Identifier, T.QuestionQuestion, T.Identifier, T.BangEqual, T.Identifier, T.Newline, T.EOF,
    ]);
  });

  it("decodes string escapes", () => {
    const [tok] = Lexer.tokenize(String.raw`"a\n\t\"b\" \u{1F600} \$x"`).tokens;
    assert.equal(tok!.type, T.String);
    assert.equal(tok!.value, 'a\n\t"b" 😀 $x');
  });

  it("splits interpolated strings into template parts", () => {
    const [tok] = Lexer.tokenize('"Hi ${user.name}, you have ${count + 1} {new} items"').tokens;
    assert.equal(tok!.type, T.Template);
    const parts = tok!.value as TemplatePart[];
    assert.deepEqual(
      parts.map((p) => (p.kind === "text" ? p.value : `<${p.source}>`)),
      ["Hi ", "<user.name>", ", you have ", "<count + 1>", " {new} items"],
    );
    const expr = parts[1] as Extract<TemplatePart, { kind: "expr" }>;
    assert.equal(expr.start.column, 7);
  });

  it("treats newlines as terminators except inside ( ) and [ ]", () => {
    assert.deepEqual(types("f(a,\n b)\n[1,\n2]"), [
      T.Identifier, T.LeftParen, T.Identifier, T.Comma, T.Identifier, T.RightParen, T.Newline,
      T.LeftBracket, T.Int, T.Comma, T.Int, T.RightBracket, T.Newline, T.EOF,
    ]);
    // ...but they are significant inside a block, even one nested in a call
    assert.ok(types("run(fn() {\n a()\n b()\n})").filter((t) => t === T.Newline).length >= 3);
  });

  it("collapses blank lines into a single newline token", () => {
    assert.deepEqual(types("a\n\n\n\nb"), [T.Identifier, T.Newline, T.Identifier, T.Newline, T.EOF]);
  });

  it("collects comments separately with positions", () => {
    const { tokens, comments } = Lexer.tokenize("// hello\nlet x = 1 /* inline */\n");
    assert.deepEqual(comments.map((c) => [c.kind, c.text, c.span.start.line]), [
      ["line", " hello", 1],
      ["block", " inline ", 2],
    ]);
    assert.ok(!tokens.some((t) => t.lexeme.includes("hello")));
  });

  it("reports errors with line and column", () => {
    const { diagnostics } = Lexer.tokenize('let a = 1\nlet b = @\nlet c = "open');
    assert.deepEqual(
      diagnostics.items.map((d) => [d.code, d.span.start.line, d.span.start.column]),
      [
        ["MK1001", 2, 9],
        ["MK1004", 3, 9],
      ],
    );
  });

  it("handles CRLF line endings", () => {
    const { tokens } = Lexer.tokenize("let a = 1\r\nlet b = 2\r\n");
    assert.equal(tokens.filter((t) => t.type === T.Newline).length, 2);
    assert.equal(tokens.find((t) => t.lexeme === "b")!.span.start.line, 2);
  });
});
