import { Analyzer, type AnalysisResult, type MKSymbol } from "../analyzer/Analyzer.js";
import { BUILTINS } from "../analyzer/builtins.js";
import { typeToString } from "../analyzer/types.js";
import type { Program } from "../ast/nodes.js";
import type { Diagnostic } from "../diagnostics.js";
import { KEYWORDS, type SourceSpan } from "../lexer/Token.js";
import { Parser } from "../parser/Parser.js";
import { VERSION } from "../version.js";

/**
 * A small Language Server Protocol implementation over stdio: diagnostics as you type, hover with
 * inferred types (including whether a function was made async), go to definition, document
 * outline and completion. Editors start it with `mk lsp`.
 */

interface Message {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: any;
  result?: unknown;
}

interface Document {
  text: string;
  version: number;
  analysis?: { program: Program; result?: AnalysisResult; diagnostics: Diagnostic[] };
}

interface Position {
  line: number;
  character: number;
}

const CONTEXTUAL = ["model", "view", "route", "test", "live", "order by", "limit", "offset", "select", "insert", "update", "delete", "set"];

export class LanguageServer {
  private readonly documents = new Map<string, Document>();
  private buffer = Buffer.alloc(0);

  constructor(private readonly send: (message: Message) => void) {}

  /** Feed raw bytes from the client; complete messages are handled as they arrive. */
  receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const length = Number(/Content-Length: (\d+)/i.exec(this.buffer.subarray(0, headerEnd).toString())?.[1]);
      const start = headerEnd + 4;
      if (this.buffer.length < start + length) return;
      const body = this.buffer.subarray(start, start + length).toString("utf8");
      this.buffer = this.buffer.subarray(start + length);
      this.handle(JSON.parse(body) as Message);
    }
  }

  handle(message: Message): void {
    const { id, method, params } = message;
    const reply = (result: unknown) => id !== undefined && this.send({ jsonrpc: "2.0", id, result });
    switch (method) {
      case "initialize":
        return void reply({
          capabilities: {
            textDocumentSync: 1,
            hoverProvider: true,
            definitionProvider: true,
            documentSymbolProvider: true,
            completionProvider: { triggerCharacters: ["."] },
          },
          serverInfo: { name: "mk", version: VERSION },
        });
      case "shutdown":
        return void reply(null);
      case "exit":
        return process.exit(0);
      case "textDocument/didOpen":
        this.documents.set(params.textDocument.uri, { text: params.textDocument.text, version: params.textDocument.version });
        return this.publish(params.textDocument.uri);
      case "textDocument/didChange": {
        const text = params.contentChanges[params.contentChanges.length - 1]?.text ?? "";
        this.documents.set(params.textDocument.uri, { text, version: params.textDocument.version });
        return this.publish(params.textDocument.uri);
      }
      case "textDocument/didClose":
        this.documents.delete(params.textDocument.uri);
        return this.send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri: params.textDocument.uri, diagnostics: [] } });
      case "textDocument/hover":
        return void reply(this.hover(params.textDocument.uri, params.position));
      case "textDocument/definition":
        return void reply(this.definition(params.textDocument.uri, params.position));
      case "textDocument/documentSymbol":
        return void reply(this.outline(params.textDocument.uri));
      case "textDocument/completion":
        return void reply(this.completion(params.textDocument.uri));
      default:
        if (id !== undefined) this.send({ jsonrpc: "2.0", id, result: null });
    }
  }

  private analyze(uri: string): Document["analysis"] {
    const doc = this.documents.get(uri);
    if (!doc) return undefined;
    if (!doc.analysis) {
      const { program, diagnostics } = Parser.parse(doc.text);
      const result = diagnostics.hasErrors ? undefined : Analyzer.analyze(program);
      doc.analysis = { program, result, diagnostics: [...diagnostics.items, ...(result?.diagnostics.items ?? [])] };
    }
    return doc.analysis;
  }

  private publish(uri: string): void {
    const diagnostics = (this.analyze(uri)?.diagnostics ?? []).map((d) => ({
      range: toRange(d.span),
      severity: d.severity === "error" ? 1 : 2,
      code: d.code,
      source: "mk",
      message: d.message,
      relatedInformation: (d.notes ?? [])
        .filter((n) => n.span)
        .map((n) => ({ location: { uri, range: toRange(n.span!) }, message: n.message })),
    }));
    this.send({ jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics } });
  }

  /** The symbol used or declared at a position. */
  private symbolAt(uri: string, pos: Position): { symbol: MKSymbol; span: SourceSpan } | undefined {
    const result = this.analyze(uri)?.result;
    if (!result) return undefined;
    for (const [id, symbol] of result.resolutions) if (contains(id.span, pos)) return { symbol, span: id.span };
    const declared = result.symbols.filter((s) => s.kind !== "builtin" && contains(s.span, pos));
    const symbol = declared.sort((a, b) => a.span.end.offset - a.span.start.offset - (b.span.end.offset - b.span.start.offset))[0];
    return symbol ? { symbol, span: symbol.span } : undefined;
  }

  hover(uri: string, pos: Position): unknown {
    const found = this.symbolAt(uri, pos);
    if (!found) return null;
    return { contents: { kind: "markdown", value: describe(found.symbol) }, range: toRange(found.span) };
  }

  definition(uri: string, pos: Position): unknown {
    const found = this.symbolAt(uri, pos);
    if (!found || found.symbol.kind === "builtin") return null;
    return { uri, range: toRange(found.symbol.span) };
  }

  outline(uri: string): unknown {
    const program = this.analyze(uri)?.program;
    if (!program) return [];
    const kinds: Record<string, number> = { FunctionDeclaration: 12, ModelDeclaration: 23, EnumDeclaration: 10, SignalDeclaration: 13, VariableDeclaration: 13, RouteDeclaration: 6, TestDeclaration: 6 };
    return program.body.flatMap((s) => {
      const name =
        "name" in s && typeof s.name === "string"
          ? s.kind === "TestDeclaration" ? `test "${s.name}"` : s.name
          : s.kind === "RouteDeclaration" ? `${s.method} ${s.path}` : undefined;
      if (!name || !(s.kind in kinds)) return [];
      return [{ name, kind: kinds[s.kind], range: toRange(s.span), selectionRange: toRange("nameSpan" in s ? s.nameSpan : s.span) }];
    });
  }

  completion(uri: string): unknown {
    const items: { label: string; kind: number; detail?: string }[] = [];
    for (const k of [...KEYWORDS.keys(), ...CONTEXTUAL]) items.push({ label: k, kind: 14 });
    for (const b of BUILTINS.values()) items.push({ label: b.name, kind: b.kind === "function" ? 3 : 6, detail: b.async ? "built-in · performs I/O" : "built-in" });
    const result = this.analyze(uri)?.result;
    for (const s of result?.symbols ?? []) {
      if (s.context?.kind !== "module") continue;
      items.push({ label: s.name, kind: s.kind === "function" ? 3 : s.kind === "model" || s.kind === "enum" ? 7 : 6, detail: typeToString(s.type) });
    }
    return items;
  }
}

function describe(s: MKSymbol): string {
  const code = (text: string) => "```mk\n" + text + "\n```";
  switch (s.kind) {
    case "function": {
      const fn = s.fn!;
      const params = fn.params.map((p) => `${p.consume ? "consume " : ""}${p.name}: ${typeToString(p.type)}`).join(", ");
      const ret = fn.returns.kind === "any" ? "" : ` -> ${typeToString(fn.returns)}`;
      const note = fn.isAsync ? "\n\n⚡ performs I/O — compiled as `async`; calls to it are awaited automatically" : "";
      return code(`fn ${s.name}(${params})${ret}`) + note;
    }
    case "signal":
      return code(`signal ${s.name}: ${typeToString(s.type)}`) + (s.derived ? "\n\nderived — recomputed when its inputs change (read-only)" : "");
    case "model":
      return code(`model ${s.name} {\n${[...(s.model?.fields ?? [])].map(([k, t]) => `    ${k}: ${typeToString(t)}`).join("\n")}\n}`);
    case "enum":
      return code(`enum ${s.name} {\n${[...s.enumInfo!.variants.values()].map((v) => `    ${v.name}${v.fields.length ? `(${v.fields.map((f) => `${f.name}: ${typeToString(f.type)}`).join(", ")})` : ""}`).join("\n")}\n}`);
    case "variant":
      return code(`${s.variant!.enumName}.${s.name}${s.variant!.fields.length ? `(${s.variant!.fields.map((f) => `${f.name}: ${typeToString(f.type)}`).join(", ")})` : ""}`);
    case "parameter":
      return code(`${s.consumeParam ? "consume " : ""}${s.name}: ${typeToString(s.type)}`) + (s.consumeParam ? "\n\nowned — the caller can't use the argument afterwards" : "");
    case "builtin":
      return code(`${s.name}`) + (s.builtin?.async ? "\n\nbuilt-in · performs I/O" : "\n\nbuilt-in");
    default:
      return code(`${s.mutable ? "var" : "let"} ${s.name}: ${typeToString(s.type)}`);
  }
}

function toRange(span: SourceSpan) {
  return {
    start: { line: span.start.line - 1, character: span.start.column - 1 },
    end: { line: span.end.line - 1, character: span.end.column - 1 },
  };
}

function contains(span: SourceSpan, pos: Position): boolean {
  const line = pos.line + 1;
  const col = pos.character + 1;
  if (line < span.start.line || line > span.end.line) return false;
  if (line === span.start.line && col < span.start.column) return false;
  if (line === span.end.line && col >= span.end.column) return false;
  return true;
}

/** Runs the server on stdin/stdout. */
export function startLanguageServer(): void {
  const server = new LanguageServer((message) => {
    const body = JSON.stringify(message);
    process.stdout.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  });
  process.stdin.on("data", (chunk: Buffer) => server.receive(chunk));
}

