import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { CompileError, formatDiagnostics } from "../diagnostics.js";
import { DEFAULT_RUNTIME_IMPORT, check } from "../compiler.js";
import { Lexer } from "../lexer/Lexer.js";
import { Parser } from "../parser/Parser.js";
import { VERSION } from "../version.js";
import { BUNDLED_RUNTIME, ProjectBuilder } from "./ProjectBuilder.js";
import { UrlCache } from "./UrlCache.js";

const HELP = `mk ${VERSION} — the MK language compiler

Usage:
  mk run <file.mk> [options] [-- program args]   compile and execute
  mk build <file.mk> [-o <dir>] [--target ts|js] write compiled output (default: ./out, TypeScript)
  mk check <file.mk>                             type-check and ownership-check only
  mk ast <file.mk>                               print the syntax tree as JSON
  mk tokens <file.mk>                            print the token stream

Options:
  --seed <file.json>     preload the database, e.g. { "User": [{ "name": "Ana" }] }
  --db <file.sqlite>     use a SQLite file (node:sqlite) instead of the in-memory database
  --debug-sql            print every SQL statement the program runs
  --reload               re-download URL imports instead of using .mk_cache
  --cache-dir <dir>      URL import cache (default: .mk_cache next to the entry file)
  --runtime <node|bun>   engine used by 'mk run' (default: the one running mk)
  --runtime-import <s>   runtime module specifier for 'mk build' (default: ${DEFAULT_RUNTIME_IMPORT})
  -h, --help             show this help
  -v, --version          show the version
`;

interface Args {
  command?: string;
  file?: string;
  flags: Map<string, string | true>;
  rest: string[];
}

const VALUE_FLAGS = new Set(["--seed", "--db", "--cache-dir", "--runtime", "--runtime-import", "-o", "--out", "--target"]);

function parseArgs(argv: string[]): Args {
  const args: Args = { flags: new Map(), rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      args.rest = argv.slice(i + 1);
      break;
    }
    if (a.startsWith("-")) {
      const [name, inline] = a.split("=", 2) as [string, string | undefined];
      if (VALUE_FLAGS.has(name)) {
        const value = inline ?? argv[++i];
        if (value === undefined) throw new UsageError(`${name} needs a value`);
        args.flags.set(name, value);
      } else {
        args.flags.set(name, true);
      }
    } else if (!args.command) args.command = a;
    else if (!args.file) args.file = a;
    else args.rest.push(a);
  }
  return args;
}

class UsageError extends Error {}

export async function main(argv: string[]): Promise<number> {
  try {
    const args = parseArgs(argv);
    if (args.flags.has("-v") || args.flags.has("--version")) {
      console.log(VERSION);
      return 0;
    }
    if (!args.command || args.flags.has("-h") || args.flags.has("--help") || args.command === "help") {
      console.log(HELP);
      return 0;
    }
    if (!args.file) throw new UsageError(`'mk ${args.command}' needs a .mk file`);

    switch (args.command) {
      case "run":
        return await run(args);
      case "build":
        return await build(args);
      case "check":
        return await checkCommand(args);
      case "ast":
        return await astCommand(args.file);
      case "tokens":
        return await tokensCommand(args.file);
      default:
        throw new UsageError(`unknown command '${args.command}'`);
    }
  } catch (e) {
    return report(e);
  }
}

function cacheFor(args: Args): UrlCache {
  const entryDir = path.dirname(path.resolve(args.file!));
  const dir = (args.flags.get("--cache-dir") as string | undefined) ?? process.env.MK_CACHE_DIR ?? path.join(entryDir, ".mk_cache");
  return new UrlCache(path.resolve(dir), { reload: args.flags.has("--reload"), log: (m) => console.error(dim(m)) });
}

async function compileForRun(args: Args): Promise<string> {
  const cache = cacheFor(args);
  const builder = new ProjectBuilder({
    target: "js",
    mode: "run",
    outDir: path.join(cache.cacheDir, "build"),
    rootDir: path.dirname(path.resolve(args.file!)),
    runtimeImport: BUNDLED_RUNTIME,
    cache,
  });
  const entry = await builder.build(args.file!);
  printWarnings(builder.warnings);
  return entry.outFile;
}

async function run(args: Args): Promise<number> {
  const outFile = await compileForRun(args);
  const env: NodeJS.ProcessEnv = { ...process.env };
  const seed = args.flags.get("--seed");
  const db = args.flags.get("--db");
  if (typeof seed === "string") env.MK_SEED = path.resolve(seed);
  if (typeof db === "string") env.MK_DB = path.resolve(db);
  if (args.flags.has("--debug-sql")) env.MK_DEBUG_SQL = "1";

  const runtime = args.flags.get("--runtime");
  const exe = runtime === "bun" ? "bun" : runtime === "node" ? "node" : process.execPath;
  const engineArgs = exe === "bun" ? ["run"] : ["--enable-source-maps", "--disable-warning=ExperimentalWarning"];

  return new Promise((resolve) => {
    const child = spawn(exe, [...engineArgs, outFile, ...args.rest], { stdio: "inherit", env });
    child.on("error", (e) => {
      console.error(red(`error: could not start ${exe}: ${e.message}`));
      resolve(1);
    });
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

async function build(args: Args): Promise<number> {
  const target = (args.flags.get("--target") as string | undefined) ?? "ts";
  if (target !== "ts" && target !== "js") throw new UsageError("--target must be 'ts' or 'js'");
  const outDir = path.resolve(((args.flags.get("-o") ?? args.flags.get("--out")) as string | undefined) ?? "out");
  const cache = cacheFor(args);
  const builder = new ProjectBuilder({
    target,
    mode: "build",
    outDir,
    rootDir: path.dirname(path.resolve(args.file!)),
    runtimeImport: (args.flags.get("--runtime-import") as string | undefined) ?? DEFAULT_RUNTIME_IMPORT,
    cache,
  });
  const entry = await builder.build(args.file!);
  printWarnings(builder.warnings);
  console.error(`wrote ${path.relative(process.cwd(), entry.outFile) || entry.outFile}`);
  return 0;
}

async function checkCommand(args: Args): Promise<number> {
  const file = args.file!;
  const source = await readFile(file, "utf8");
  const hasImports = /^\s*import\b/m.test(source);
  if (hasImports) {
    // Imports need their interfaces (async-ness, consume parameters): build the whole graph.
    await compileForRun(args);
  } else {
    const diagnostics = check(source, { file });
    const errors = diagnostics.filter((d) => d.severity === "error").length;
    if (diagnostics.length) console.error(colorize(formatDiagnostics(diagnostics, source, file)));
    if (errors) {
      console.error(red(`\nmk: ${errors} error${errors === 1 ? "" : "s"} in ${file}`));
      return 1;
    }
  }
  console.error(green(`✓ ${file}: no errors`));
  return 0;
}

async function astCommand(file: string): Promise<number> {
  const source = await readFile(file, "utf8");
  const { program, diagnostics } = Parser.parse(source);
  if (diagnostics.hasErrors) throw new CompileError(diagnostics.items, source, file);
  console.log(JSON.stringify(program, (key, value) => (key === "span" || key.endsWith("Span") ? undefined : value), 2));
  return 0;
}

async function tokensCommand(file: string): Promise<number> {
  const source = await readFile(file, "utf8");
  const { tokens, diagnostics } = Lexer.tokenize(source);
  if (diagnostics.hasErrors) throw new CompileError(diagnostics.items, source, file);
  for (const t of tokens) {
    const pos = `${t.span.start.line}:${t.span.start.column}`.padEnd(8);
    console.log(`${pos}${t.type.padEnd(14)}${t.type === "Newline" ? "" : t.lexeme}`);
  }
  return 0;
}

function report(e: unknown): number {
  if (e instanceof CompileError) {
    console.error(colorize(e.message));
    const errors = e.diagnostics.filter((d) => d.severity === "error").length;
    console.error(red(`\nmk: ${errors} error${errors === 1 ? "" : "s"} in ${e.file}`));
  } else if (e instanceof UsageError) {
    console.error(red(`error: ${e.message}`));
    console.error("run 'mk --help' for usage");
  } else {
    console.error(red(`error: ${(e as Error).message ?? e}`));
  }
  return 1;
}

function printWarnings(warnings: string[]): void {
  for (const w of warnings) console.error(colorize(w) + "\n");
}

const useColor = process.stderr.isTTY && !process.env.NO_COLOR;
const paint = (code: number) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const red = paint(31);
const yellow = paint(33);
const green = paint(32);
const dim = paint(2);

function colorize(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.startsWith("error[") ? red(line) : line.startsWith("warning[") ? yellow(line) : line))
    .join("\n");
}
