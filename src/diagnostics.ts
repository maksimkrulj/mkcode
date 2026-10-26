import type { SourceSpan } from "./lexer/Token.js";

export type Severity = "error" | "warning";

export interface Diagnostic {
  severity: Severity;
  /** Stable machine-readable code, e.g. `MK3001`. */
  code: string;
  message: string;
  span: SourceSpan;
  /** Extra context, e.g. where a variable was consumed. */
  notes?: { message: string; span?: SourceSpan }[];
}

/** Thrown when a compilation phase cannot continue; carries every diagnostic collected so far. */
export class CompileError extends Error {
  constructor(
    readonly diagnostics: Diagnostic[],
    readonly source: string,
    readonly file: string,
  ) {
    super(formatDiagnostics(diagnostics, source, file));
    this.name = "CompileError";
  }
}

/** Collects diagnostics for one phase. */
export class DiagnosticBag {
  readonly items: Diagnostic[] = [];

  error(code: string, message: string, span: SourceSpan, notes?: Diagnostic["notes"]): void {
    const last = this.items[this.items.length - 1];
    if (last && last.message === message && last.span.start.offset === span.start.offset) return;
    this.items.push({ severity: "error", code, message, span, notes });
  }

  warning(code: string, message: string, span: SourceSpan, notes?: Diagnostic["notes"]): void {
    this.items.push({ severity: "warning", code, message, span, notes });
  }

  get hasErrors(): boolean {
    return this.items.some((d) => d.severity === "error");
  }
}

/**
 * Render diagnostics in a rustc-like layout:
 *
 *   error[MK3001]: use of consumed variable 'buf'
 *     --> example.mk:24:11
 *      |
 *   24 |     print(buf)
 *      |           ^^^
 *      = note: 'buf' was consumed here (22:17)
 */
export function formatDiagnostics(diagnostics: Diagnostic[], source: string, file: string): string {
  const lines = source.split(/\r?\n/);
  return diagnostics.map((d) => formatOne(d, lines, file)).join("\n\n");
}

function formatOne(d: Diagnostic, lines: string[], file: string): string {
  const { line, column } = d.span.start;
  const gutter = String(line).length;
  const pad = " ".repeat(gutter);
  const text = lines[line - 1] ?? "";
  const width =
    d.span.end.line === line ? Math.max(1, d.span.end.column - column) : Math.max(1, text.length - column + 1);
  const out = [
    `${d.severity}[${d.code}]: ${d.message}`,
    `${pad}--> ${file}:${line}:${column}`,
    `${pad} |`,
    `${line} | ${text}`,
    `${pad} | ${" ".repeat(column - 1)}${"^".repeat(width)}`,
  ];
  for (const note of d.notes ?? []) {
    const at = note.span ? ` (${note.span.start.line}:${note.span.start.column})` : "";
    out.push(`${pad} = note: ${note.message}${at}`);
  }
  return out.join("\n");
}
