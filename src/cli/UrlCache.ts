import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

interface ManifestEntry {
  /** File name of the original download inside `remote/`. */
  file: string;
  /** Subresource-integrity style hash of the original bytes. */
  integrity: string;
  /** Final URL after redirects; relative imports resolve against it. */
  resolvedUrl: string;
  contentType?: string;
  fetchedAt: string;
}

interface Manifest {
  version: 1;
  entries: Record<string, ManifestEntry>;
}

export interface UrlCacheOptions {
  /** Ignore cached copies and download again. */
  reload?: boolean;
  log?: (message: string) => void;
  fetch?: typeof globalThis.fetch;
}

/** Static `import`/`export ... from`, side-effect `import "x"` and literal `import("x")`. */
const IMPORT_SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(["'])([^"'\n]+)\2/g;

/**
 * Fetch-and-cache store for URL imports, rooted at `.mk_cache/`.
 *
 * Downloads are kept verbatim under `remote/` and recorded in `manifest.json` with a SHA-256
 * integrity hash, so later runs work offline and a tampered cache is detected. JavaScript and
 * TypeScript modules are additionally written as runnable copies whose own URL imports are
 * rewritten (recursively) to point at their cached files.
 */
export class UrlCache {
  readonly remoteDir: string;
  private readonly manifestPath: string;
  private manifest?: Manifest;
  private readonly modulePaths = new Map<string, string>();
  private readonly pending = new Map<string, Promise<string>>();
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(
    readonly cacheDir: string,
    private readonly options: UrlCacheOptions = {},
  ) {
    this.remoteDir = path.join(cacheDir, "remote");
    this.manifestPath = path.join(cacheDir, "manifest.json");
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  static isUrl(specifier: string): boolean {
    return /^https?:\/\//i.test(specifier);
  }

  /** Text of a remote resource (e.g. an `.mk` module), from cache when possible. */
  async text(url: string): Promise<{ text: string; resolvedUrl: string }> {
    const { bytes, entry } = await this.load(url);
    return { text: bytes.toString("utf8"), resolvedUrl: entry.resolvedUrl };
  }

  /** Absolute path of a runnable local copy of the JS/TS module at `url`. */
  module(url: string): Promise<string> {
    const done = this.modulePaths.get(url);
    if (done) return Promise.resolve(done);
    let job = this.pending.get(url);
    if (!job) {
      job = this.materialize(url);
      this.pending.set(url, job);
    }
    return job;
  }

  private async materialize(url: string): Promise<string> {
    const { bytes, entry } = await this.load(url);
    const ext = moduleExtension(entry.resolvedUrl, entry.contentType);
    const target = path.join(this.remoteDir, `${path.parse(entry.file).name}${ext}`);
    // Register before recursing so import cycles between remote modules terminate.
    this.modulePaths.set(url, target);

    let code = bytes.toString("utf8");
    const replacements = new Map<string, string>();
    for (const match of code.matchAll(IMPORT_SPECIFIER)) {
      const spec = match[3]!;
      if (replacements.has(spec) || !isUrlLike(spec)) continue;
      const absolute = new URL(spec, entry.resolvedUrl).href;
      if (!UrlCache.isUrl(absolute)) continue;
      const local = await this.module(absolute);
      replacements.set(spec, `./${path.basename(local)}`);
    }
    if (replacements.size) {
      code = code.replace(IMPORT_SPECIFIER, (all, lead: string, quote: string, spec: string) =>
        replacements.has(spec) ? `${lead}${quote}${replacements.get(spec)}${quote}` : all,
      );
    }
    await writeFile(target, code);
    return target;
  }

  private async load(url: string): Promise<{ bytes: Buffer; entry: ManifestEntry }> {
    const manifest = await this.readManifest();
    const cached = manifest.entries[url];
    if (cached && !this.options.reload) {
      const file = path.join(this.remoteDir, cached.file);
      if (existsSync(file)) {
        const bytes = await readFile(file);
        const actual = integrity(bytes);
        if (actual !== cached.integrity) {
          throw new Error(
            `integrity check failed for ${url}\n  expected ${cached.integrity}\n  found    ${actual}\n` +
              "The cached copy was modified. Re-download it with --reload.",
          );
        }
        return { bytes, entry: cached };
      }
    }

    if (url.startsWith("http://") && !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/)/.test(url)) {
      this.options.log?.(`warning: importing over insecure http: ${url}`);
    }
    this.options.log?.(`fetch ${url}`);
    let res: Response;
    try {
      res = await this.fetchImpl(url, { redirect: "follow" });
    } catch (e) {
      throw new Error(`could not fetch ${url}: ${(e as Error).message}`);
    }
    if (!res.ok) throw new Error(`could not fetch ${url}: HTTP ${res.status} ${res.statusText}`);
    const bytes = Buffer.from(await res.arrayBuffer());

    const hash = createHash("sha256").update(url).digest("hex").slice(0, 16);
    const entry: ManifestEntry = {
      file: `${hash}-${safeBaseName(url)}.orig`,
      integrity: integrity(bytes),
      resolvedUrl: res.url || url,
      contentType: res.headers.get("content-type") ?? undefined,
      fetchedAt: new Date().toISOString(),
    };
    await mkdir(this.remoteDir, { recursive: true });
    await writeFile(path.join(this.remoteDir, entry.file), bytes);
    manifest.entries[url] = entry;
    await this.writeManifest();
    return { bytes, entry };
  }

  private async readManifest(): Promise<Manifest> {
    if (this.manifest) return this.manifest;
    try {
      const parsed = JSON.parse(await readFile(this.manifestPath, "utf8")) as Manifest;
      this.manifest = parsed.version === 1 ? parsed : { version: 1, entries: {} };
    } catch {
      this.manifest = { version: 1, entries: {} };
    }
    return this.manifest;
  }

  private async writeManifest(): Promise<void> {
    await mkdir(this.cacheDir, { recursive: true });
    const sorted = Object.fromEntries(Object.entries(this.manifest!.entries).sort(([a], [b]) => a.localeCompare(b)));
    await writeFile(this.manifestPath, JSON.stringify({ version: 1, entries: sorted }, null, 2) + "\n");
  }
}

function integrity(bytes: Buffer): string {
  return `sha256-${createHash("sha256").update(bytes).digest("base64")}`;
}

function isUrlLike(spec: string): boolean {
  return UrlCache.isUrl(spec) || spec.startsWith("/") || spec.startsWith("./") || spec.startsWith("../");
}

function safeBaseName(url: string): string {
  const { pathname } = new URL(url);
  const base = pathname.split("/").filter(Boolean).pop() ?? "index";
  return base.replace(/\.[^.]*$/, "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40) || "index";
}

/** Always an ES-module extension, so the cache works regardless of the project's `"type"`. */
function moduleExtension(url: string, contentType?: string): string {
  const ext = path.extname(new URL(url).pathname).toLowerCase();
  if (ext === ".ts" || ext === ".mts" || contentType?.includes("typescript")) return ".mts";
  if (ext === ".json" || contentType?.includes("json")) return ".json";
  return ".mjs";
}
