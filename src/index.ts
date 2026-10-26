export { Lexer, type LexResult } from "./lexer/Lexer.js";
export { TokenType, KEYWORDS, type Token, type Comment, type SourceSpan, type SourcePosition } from "./lexer/Token.js";
export { Parser, type ParseResult } from "./parser/Parser.js";
export {
  Analyzer,
  type AnalysisResult,
  type AnalyzerOptions,
  type ModuleInterface,
  type ExportedSymbol,
  type MKSymbol,
} from "./analyzer/Analyzer.js";
export { CodeGenerator, type CodegenOptions } from "./codegen/CodeGenerator.js";
export { CompileError, DiagnosticBag, formatDiagnostics, type Diagnostic } from "./diagnostics.js";
export {
  compile,
  compileProgram,
  analyzeProgram,
  parseSource,
  importSpecifiers,
  check,
  DEFAULT_RUNTIME_IMPORT,
  type CompileOptions,
  type CompileOutput,
} from "./compiler.js";
export { VERSION } from "./version.js";
export type * as AST from "./ast/nodes.js";
