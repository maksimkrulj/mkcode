import { spawn, type ChildProcess } from "node:child_process";
import { readdirSync, readFileSync, statSync, watch } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { CompileError, formatDiagnostics } from "../diagnostics.js";
import { DEFAULT_RUNTIME_IMPORT, check } from "../compiler.js";
import { Lexer } from "../lexer/Lexer.js";
import { Parser } from "../parser/Parser.js";
import { SqliteAdapter } from "../runtime/db.js";
import { VERSION } from "../version.js";
import { startLanguageServer } from "./lsp.js";
import { BUNDLED_RUNTIME, ProjectBuilder } from "./ProjectBuilder.js";
import { UrlCache } from "./UrlCache.js";

const HELP = `mk ${VERSION} — the MK language compiler

Usage:
  mk run <file.mk> [options] [-- program args]   compile and execute
  mk serve <file.mk> [--port 3000] [--watch]     run and serve its routes (restarts on change with --watch)
  mk test [file.mk | dir] [--filter text]        run test blocks, each with a fresh database
  mk build <file.mk> [-o <dir>] [--target ts|js] write compiled output (default: ./out, TypeScript)
  mk check <file.mk>                             type-check and ownership-check only
  mk db migrate <file.mk> --db <file.sqlite>     create/alter tables to match the models
  mk ast <file.mk>                               print the syntax tree as JSON
  mk tokens <file.mk>                            print the token stream
  mk lsp                                         start the language server (stdio)

Options:
  --seed <file.json>     preload the database, e.g. { "User": [{ "name": "Ana" }] }
  --db <file.sqlite>     use a SQLite file (node:sqlite) instead of the in-memory database
  --debug-sql            print every SQL statement the program runs
  --reload               re-download URL imports instead of using .mk_cache
  --cache-dir <dir>      URL import cache (default: .mk_cache next to the entry file)
  --runtime <node|bun>   engine used by 'mk run' (default: the one running mk)
  --runtime-import <s>   runtime module specifier for 'mk build' (default: ${DEFAULT_RUNTIME_IMPORT})
  --dry-run              (db migrate) print the SQL without running it
  --allow-drop           (db migrate) also drop columns that left the model
  -h, --help             show this help
  -v, --version          show the version
`;

interface Args {
  command?: string;
  positionals: string[];
  flags: Map<string, string | true>;
  rest: string[];
}

const VALUE_FLAGS = new Set([
  "--seed", "--db", "--cache-dir", "--runtime", "--runtime-import", "-o", "--out", "--target", "--port", "--filter",
]);

function parseArgs(argv: string[]): Args {
  const args: Args = { positionals: [], flags: new Map(), rest: [] };
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
    else args.positionals.push(a);
  }
  return args;
}

class UsageError extends Error {}

function needFile(args: Args, index = 0): string {
  const file = args.positionals[index];
  if (!file) throw new UsageError(`'mk ${args.command}' needs a .mk file`);
  return file;
}

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
    switch (args.command) {
      case "run":
        return await run(args, needFile(args));
      case "serve":
        return await serve(args, needFile(args));
      case "test":
        return await testCommand(args);
      case "build":
        return await build(args, needFile(args));
      case "check":
        return await checkCommand(args, needFile(args));
      case "db":
        if (args.positionals[0] !== "migrate") throw new UsageError("usage: mk db migrate <file.mk> --db <file.sqlite>");
        return await migrate(args, needFile(args, 1));
      case "ast":
        return await astCommand(needFile(args));
      case "tokens":
        return await tokensCommand(needFile(args));
      case "lsp":
        startLanguageServer();
        return await new Promise<number>(() => {});
      default:
        throw new UsageError(`unknown command '${args.command}'`);
    }
  } catch (e) {
    return report(e);
  }
}

function cacheFor(args: Args, file: string): UrlCache {
  const entryDir = path.dirname(path.resolve(file));
  const dir = (args.flags.get("--cache-dir") as string | undefined) ?? process.env.MK_CACHE_DIR ?? path.join(entryDir, ".mk_cache");
  return new UrlCache(path.resolve(dir), { reload: args.flags.has("--reload"), log: (m) => console.error(dim(m)) });
}

async function compileForRun(args: Args, file: string): Promise<{ outFile: string; builder: ProjectBuilder }> {
  const cache = cacheFor(args, file);
  const builder = new ProjectBuilder({
    target: "js",
    mode: "run",
    outDir: path.join(cache.cacheDir, "build"),
    rootDir: path.dirname(path.resolve(file)),
    runtimeImport: BUNDLED_RUNTIME,
    cache,
  });
  const entry = await builder.build(file);
  printWarnings(builder.warnings);
  return { outFile: entry.outFile, builder };
}

function programEnv(args: Args, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  const seed = args.flags.get("--seed");
  const db = args.flags.get("--db");
  if (typeof seed === "string") env.MK_SEED = path.resolve(seed);
  if (typeof db === "string") env.MK_DB = path.resolve(db);
  if (args.flags.has("--debug-sql")) env.MK_DEBUG_SQL = "1";
  return env;
}

function launch(args: Args, outFile: string, env: NodeJS.ProcessEnv): ChildProcess {
  const runtime = args.flags.get("--runtime");
  const exe = runtime === "bun" ? "bun" : runtime === "node" ? "node" : process.execPath;
  const engineArgs = exe === "bun" ? ["run"] : ["--enable-source-maps", "--disable-warning=ExperimentalWarning"];
  const child = spawn(exe, [...engineArgs, outFile, ...args.rest], { stdio: "inherit", env });
  // Stopping `mk` must stop the program too, or a server would outlive it.
  const forward = (signal: NodeJS.Signals) => () => child.kill(signal);
  const handlers = (["SIGINT", "SIGTERM", "SIGHUP"] as const).map((s) => [s, forward(s)] as const);
  for (const [s, h] of handlers) process.on(s, h);
  child.on("exit", () => {
    for (const [s, h] of handlers) process.off(s, h);
  });
  return child;
}

function exitCode(child: ChildProcess): Promise<number> {
  return new Promise((resolve) => {
    child.on("error", (e) => {
      console.error(red(`error: could not start the program: ${e.message}`));
      resolve(1);
    });
    child.on("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

async function run(args: Args, file: string): Promise<number> {
  const { outFile } = await compileForRun(args, file);
  return exitCode(launch(args, outFile, programEnv(args)));
}

/** Runs the program with its routes served; with --watch, recompiles and restarts on every change. */
async function serve(args: Args, file: string): Promise<number> {
  const port = String(args.flags.get("--port") ?? process.env.PORT ?? "3000");
  const env = programEnv(args, { MK_SERVE_PORT: port });
  if (!args.flags.has("--watch")) {
    const { outFile } = await compileForRun(args, file);
    return exitCode(launch(args, outFile, env));
  }

  let child: ChildProcess | undefined;
  let files = new Set<string>();
  const start = async () => {
    try {
      const { outFile, builder } = await compileForRun(args, file);
      files = builder.files;
      child = launch(args, outFile, env);
    } catch (e) {
      report(e);
      console.error(dim("waiting for changes..."));
    }
  };
  const restart = async () => {
    if (child && child.exitCode === null) {
      const exited = new Promise((resolve) => child!.once("exit", resolve));
      child.kill();
      await exited;
    }
    console.error(dim(`\n↻ change detected, restarting ${file}`));
    await start();
  };

  await start();
  let timer: NodeJS.Timeout | undefined;
  const root = path.dirname(path.resolve(file));
  watch(root, { recursive: true }, (_event, name) => {
    if (!name || !name.endsWith(".mk") || name.includes(".mk_cache")) return;
    const changed = path.resolve(root, name.toString());
    if (files.size && !files.has(changed)) return;
    clearTimeout(timer);
    timer = setTimeout(() => void restart(), 120);
  });
  return new Promise<number>(() => {});
}

/** Finds `.mk` files containing `test "..." { }` blocks and runs each one under MK_TEST=1. */
async function testCommand(args: Args): Promise<number> {
  const target = path.resolve(args.positionals[0] ?? ".");
  const files = statSync(target).isDirectory() ? findTestFiles(target) : [target];
  if (!files.length) {
    console.error("no .mk files with test blocks found");
    return 1;
  }
  let failed = false;
  for (const file of files) {
    const shown = path.relative(process.cwd(), file) || file;
    console.log(`\n${bold(shown)}`);
    const { outFile } = await compileForRun(args, file);
    const extra: Record<string, string> = { MK_TEST: "1" };
    const filter = args.flags.get("--filter");
    if (typeof filter === "string") extra.MK_TEST_FILTER = filter;
    if ((await exitCode(launch(args, outFile, programEnv(args, extra)))) !== 0) failed = true;
  }
  return failed ? 1 : 0;
}

function findTestFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findTestFiles(full));
    else if (entry.name.endsWith(".mk") && /^\s*test\s+"/m.test(readFileSync(full, "utf8"))) found.push(full);
  }
  return found.sort();
}

async function migrate(args: Args, file: string): Promise<number> {
  const dbFile = args.flags.get("--db");
  if (typeof dbFile !== "string") throw new UsageError("mk db migrate needs --db <file.sqlite>");
  const { builder } = await compileForRun(args, file);
  if (!builder.models.size) {
    console.error("no model declarations found");
    return 0;
  }
  const adapter = await SqliteAdapter.open(path.resolve(dbFile));
  const dryRun = args.flags.has("--dry-run");
  const models = [...builder.models].map(([name, fields]) => ({ name, fields }));
  const plan = adapter.migrate(models, { dryRun, allowDrop: args.flags.has("--allow-drop") });
  adapter.close();
  for (const w of plan.warnings) console.error(yellow(`warning: ${w}`));
  if (!plan.statements.length) {
    console.log(green(`✓ ${dbFile} already matches ${models.length} model(s)`));
    return 0;
  }
  for (const sql of plan.statements) console.log(`${sql};`);
  console.log(dryRun ? dim(`\n(dry run — ${plan.statements.length} statement(s) not applied)`) : green(`\n✓ applied ${plan.statements.length} statement(s) to ${dbFile}`));
  return 0;
}

async function build(args: Args, file: string): Promise<number> {
  const target = (args.flags.get("--target") as string | undefined) ?? "ts";
  if (target !== "ts" && target !== "js") throw new UsageError("--target must be 'ts' or 'js'");
  const outDir = path.resolve(((args.flags.get("-o") ?? args.flags.get("--out")) as string | undefined) ?? "out");
  const cache = cacheFor(args, file);
  const builder = new ProjectBuilder({
    target,
    mode: "build",
    outDir,
    rootDir: path.dirname(path.resolve(file)),
    runtimeImport: (args.flags.get("--runtime-import") as string | undefined) ?? DEFAULT_RUNTIME_IMPORT,
    cache,
  });
  const entry = await builder.build(file);
  printWarnings(builder.warnings);
  console.error(`wrote ${path.relative(process.cwd(), entry.outFile) || entry.outFile}`);
  return 0;
}

async function checkCommand(args: Args, file: string): Promise<number> {
  const source = await readFile(file, "utf8");
  if (/^\s*import\b/m.test(source)) {
    // Imports need their interfaces (async-ness, consume parameters): build the whole graph.
    await compileForRun(args, file);
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
const bold = paint(1);

function colorize(text: string): string {
  return text
    .split("\n")
    .map((line) => (line.startsWith("error[") ? red(line) : line.startsWith("warning[") ? yellow(line) : line))
    .join("\n");
}
