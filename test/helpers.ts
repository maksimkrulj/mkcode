import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Analyzer, type AnalysisResult, type AnalyzerOptions } from "../src/analyzer/Analyzer.js";
import type { Program } from "../src/ast/nodes.js";
import { compile, type CompileOptions } from "../src/compiler.js";
import type { Diagnostic } from "../src/diagnostics.js";
import { Parser } from "../src/parser/Parser.js";

/** Project root (tests run from dist/test). */
export const ROOT = path.resolve(import.meta.dirname, "../..");
export const RUNTIME_URL = new URL("../src/runtime/index.js", import.meta.url).href;
export const CLI = path.join(ROOT, "bin", "mk.js");

export function parse(source: string): Program {
  const { program, diagnostics } = Parser.parse(source);
  if (diagnostics.hasErrors) {
    throw new Error(`unexpected parse errors:\n${diagnostics.items.map((d) => `${d.code} ${d.message}`).join("\n")}`);
  }
  return program;
}

export function analyze(source: string, options?: AnalyzerOptions): AnalysisResult & { program: Program } {
  const program = parse(source);
  return { ...Analyzer.analyze(program, options), program };
}

export function errors(source: string, options?: AnalyzerOptions): Diagnostic[] {
  return analyze(source, options).diagnostics.items.filter((d) => d.severity === "error");
}

export function errorCodes(source: string, options?: AnalyzerOptions): string[] {
  return errors(source, options).map((d) => d.code);
}

export function toTS(source: string, options: CompileOptions = {}): string {
  return compile(source, { file: "test.mk", ...options }).code;
}

export function toJS(source: string, options: CompileOptions = {}): string {
  return compile(source, { file: "test.mk", target: "js", runtimeImport: RUNTIME_URL, ...options }).code;
}

export function tempDir(prefix = "mk-test-"): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Compiles to JS, runs it in a fresh Node process and returns stdout. */
export function runMK(source: string, env: Record<string, string> = {}): string {
  const dir = tempDir();
  const file = path.join(dir, "main.mjs");
  writeFileSync(file, toJS(source));
  return execFileSync(process.execPath, [file], { encoding: "utf8", env: { ...process.env, ...env } });
}

/** Runs the `mk` CLI; never throws, returns exit code and output. */
export function cli(args: string[], options: { cwd?: string; env?: Record<string, string> } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], {
      encoding: "utf8",
      cwd: options.cwd ?? ROOT,
      env: { ...process.env, NO_COLOR: "1", ...options.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, stdout: err.stdout, stderr: err.stderr };
  }
}
