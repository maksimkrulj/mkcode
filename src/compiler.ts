import { Analyzer, type AnalysisResult, type ModuleInterface } from "./analyzer/Analyzer.js";
import type { Program } from "./ast/nodes.js";
import { CodeGenerator } from "./codegen/CodeGenerator.js";
import { CompileError, type Diagnostic } from "./diagnostics.js";
import { Parser } from "./parser/Parser.js";

export interface CompileOptions {
  /** File name used in diagnostics and the output header. */
  file?: string;
  target?: "ts" | "js";
  runtimeImport?: string;
  rewriteImport?: (specifier: string) => string;
  resolveModule?: (specifier: string) => ModuleInterface | undefined;
  /** Call `main()` at the end of the module (default `true`). */
  entry?: boolean;
}

export interface CompileOutput {
  code: string;
  program: Program;
  analysis: AnalysisResult;
  /** Non-fatal diagnostics. */
  warnings: Diagnostic[];
}

export const DEFAULT_RUNTIME_IMPORT = "mk-lang/runtime";

/** Lex + parse. Throws `CompileError` on syntax errors. */
export function parseSource(source: string, file = "<input>"): Program {
  const { program, diagnostics } = Parser.parse(source);
  if (diagnostics.hasErrors) throw new CompileError(diagnostics.items, source, file);
  return program;
}

/** Imports declared by a parsed module, in source order. */
export function importSpecifiers(program: Program): string[] {
  return program.body.flatMap((s) => (s.kind === "ImportDeclaration" ? [s.source] : []));
}

/** Semantic analysis. Throws `CompileError` if any error was found. */
export function analyzeProgram(program: Program, source: string, options: CompileOptions = {}): AnalysisResult {
  const analysis = Analyzer.analyze(program, { resolveModule: options.resolveModule });
  if (analysis.diagnostics.hasErrors) {
    throw new CompileError(analysis.diagnostics.items, source, options.file ?? "<input>");
  }
  return analysis;
}

/** Full pipeline for an already-parsed module. */
export function compileProgram(program: Program, source: string, options: CompileOptions = {}): CompileOutput {
  const analysis = analyzeProgram(program, source, options);
  const code = CodeGenerator.generate(program, analysis, {
    target: options.target ?? "ts",
    runtimeImport: options.runtimeImport ?? DEFAULT_RUNTIME_IMPORT,
    rewriteImport: options.rewriteImport,
    entry: options.entry ?? true,
    sourceName: options.file ?? "<input>",
  });
  return { code, program, analysis, warnings: analysis.diagnostics.items.filter((d) => d.severity === "warning") };
}

/** Source → TypeScript (or JavaScript). Throws `CompileError` with every diagnostic on failure. */
export function compile(source: string, options: CompileOptions = {}): CompileOutput {
  return compileProgram(parseSource(source, options.file), source, options);
}

/** Collects all diagnostics without throwing (for editors and `mk check`). */
export function check(source: string, options: CompileOptions = {}): Diagnostic[] {
  const { program, diagnostics } = Parser.parse(source);
  if (diagnostics.hasErrors) return diagnostics.items;
  return [...diagnostics.items, ...Analyzer.analyze(program, { resolveModule: options.resolveModule }).diagnostics.items];
}
