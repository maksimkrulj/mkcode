import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ModuleInterface } from "../analyzer/Analyzer.js";
import { compileProgram, importSpecifiers, parseSource } from "../compiler.js";
import { formatDiagnostics } from "../diagnostics.js";
import { UrlCache } from "./UrlCache.js";

export interface BuildOptions {
  target: "ts" | "js";
  /** `run`: flat output in the cache for immediate execution. `build`: mirrors the source tree. */
  mode: "run" | "build";
  outDir: string;
  /** Directory of the entry module; `build` output mirrors paths relative to it. */
  rootDir: string;
  runtimeImport: string;
  cache: UrlCache;
}

export interface BuiltModule {
  id: string;
  outFile: string;
  interface: ModuleInterface;
}

type Resolved =
  | { kind: "mk"; id: string }
  | { kind: "url"; url: string }
  | { kind: "file"; path: string }
  | { kind: "bare" };

/** Absolute `file:` URL of the runtime that ships with this compiler. */
export const BUNDLED_RUNTIME = new URL("../runtime/index.js", import.meta.url).href;

/**
 * Compiles an entry `.mk` file and everything it imports: local and remote `.mk` modules are
 * compiled (dependencies first, so importers see their exports' async-ness and ownership
 * rules), URL imports of JS/TS are fetched into the cache, and every specifier is rewritten
 * to point at the generated or cached file.
 */
export class ProjectBuilder {
  /** Formatted warnings from every compiled module. */
  readonly warnings: string[] = [];
  private readonly built = new Map<string, BuiltModule>();
  private readonly stack: string[] = [];

  constructor(private readonly options: BuildOptions) {}

  build(entryFile: string): Promise<BuiltModule> {
    return this.buildModule(path.resolve(entryFile), true);
  }

  private async buildModule(id: string, entry: boolean): Promise<BuiltModule> {
    const done = this.built.get(id);
    if (done) return done;
    if (this.stack.includes(id)) {
      const cycle = [...this.stack.slice(this.stack.indexOf(id)), id].map((m) => this.displayName(m)).join(" -> ");
      throw new Error(`circular import between MK modules: ${cycle}`);
    }
    this.stack.push(id);
    try {
      const remote = UrlCache.isUrl(id);
      const { text: source, resolvedUrl } = remote ? await this.options.cache.text(id) : { text: await readFile(id, "utf8"), resolvedUrl: id };
      const file = this.displayName(id);
      const program = parseSource(source, file);
      const outFile = this.outFileFor(id);

      const deps = new Map<string, BuiltModule>();
      const rewrites = new Map<string, string>();
      for (const spec of importSpecifiers(program)) {
        const resolved = this.resolve(spec, resolvedUrl);
        switch (resolved.kind) {
          case "mk": {
            const dep = await this.buildModule(resolved.id, false);
            deps.set(spec, dep);
            rewrites.set(spec, this.relativeImport(outFile, dep.outFile));
            break;
          }
          case "url":
            rewrites.set(spec, this.relativeImport(outFile, await this.options.cache.module(resolved.url)));
            break;
          case "file":
            rewrites.set(spec, this.relativeImport(outFile, resolved.path));
            break;
        }
      }

      const output = compileProgram(program, source, {
        file,
        target: this.options.target,
        runtimeImport: this.options.runtimeImport,
        entry,
        rewriteImport: (s) => rewrites.get(s) ?? s,
        resolveModule: (s) => deps.get(s)?.interface,
      });
      if (output.warnings.length) this.warnings.push(formatDiagnostics(output.warnings, source, file));

      await mkdir(path.dirname(outFile), { recursive: true });
      await writeFile(outFile, output.code);
      const module: BuiltModule = { id, outFile, interface: output.analysis.interface };
      this.built.set(id, module);
      return module;
    } finally {
      this.stack.pop();
    }
  }

  private resolve(spec: string, base: string): Resolved {
    const isMk = (s: string) => /\.mk$/i.test(new URL(s, "file:///").pathname);
    if (UrlCache.isUrl(spec)) return isMk(spec) ? { kind: "mk", id: spec } : { kind: "url", url: spec };
    if (!/^(\.{1,2}\/|\/)/.test(spec)) return { kind: "bare" };
    if (UrlCache.isUrl(base)) {
      const url = new URL(spec, base).href;
      return isMk(url) ? { kind: "mk", id: url } : { kind: "url", url };
    }
    const file = path.resolve(path.dirname(base), spec);
    return /\.mk$/i.test(file) ? { kind: "mk", id: file } : { kind: "file", path: file };
  }

  private outFileFor(id: string): string {
    const ext = this.options.target === "ts" ? ".ts" : ".mjs";
    const hash = createHash("sha256").update(id).digest("hex").slice(0, 8);
    const base = path.basename(UrlCache.isUrl(id) ? new URL(id).pathname : id).replace(/\.mk$/i, "") || "index";
    if (this.options.mode === "build" && !UrlCache.isUrl(id)) {
      const rel = path.relative(this.options.rootDir, id);
      if (!rel.startsWith("..") && !path.isAbsolute(rel)) return path.join(this.options.outDir, rel.replace(/\.mk$/i, ext));
    }
    const dir = this.options.mode === "build" ? path.join(this.options.outDir, "_deps") : this.options.outDir;
    return path.join(dir, `${base}-${hash}${ext}`);
  }

  private relativeImport(fromFile: string, toFile: string): string {
    // TypeScript (NodeNext) imports sibling `.ts` sources through their `.js` output name.
    const target = this.options.target === "ts" && toFile.endsWith(".ts") ? toFile.replace(/\.ts$/, ".js") : toFile;
    const rel = path.relative(path.dirname(fromFile), target);
    if (path.isAbsolute(rel)) return pathToFileURL(target).href; // different drive on Windows
    const posix = rel.split(path.sep).join("/");
    return posix.startsWith(".") ? posix : `./${posix}`;
  }

  private displayName(id: string): string {
    if (UrlCache.isUrl(id)) return id;
    const rel = path.relative(process.cwd(), id);
    return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel.split(path.sep).join("/") : id;
  }
}
