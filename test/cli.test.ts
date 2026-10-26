import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { CLI, ROOT, cli, tempDir } from "./helpers.js";

/** Async CLI runner: the HTTP server below lives in this process, so we must not block it. */
function mk(args: string[], cwd = ROOT): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } }, (err, stdout, stderr) =>
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    );
  });
}

describe("CLI", () => {
  it("prints help and version", () => {
    assert.match(cli(["--help"]).stdout, /mk run <file\.mk>/);
    assert.match(cli(["--version"]).stdout, /^\d+\.\d+\.\d+/);
    assert.equal(cli(["frobnicate", "x.mk"]).code, 1);
  });

  it("runs example.mk", () => {
    const res = cli(["run", "example.mk", "--seed", "examples/users.seed.json"]);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /Processing buffer\.\.\.\nTop Users: \[/);
    assert.match(res.stdout, /name: 'Ana'/);
  });

  it("runs the showcase with a local .mk import and a SQLite database", () => {
    const db = path.join(tempDir(), "app.sqlite");
    const res = cli(["run", "examples/showcase.mk", "--db", db]);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /^\[effect\] threshold is 60\n2 users: Ana, Stefan\n\[effect\] threshold is 50\n/);
    assert.match(res.stdout, /count: 3 \| first S: Stefan 70/);
    assert.ok(existsSync(db));
  });

  it("check reports every ownership error with its location", () => {
    const res = cli(["check", "examples/errors/ownership.mk"]);
    assert.equal(res.code, 1);
    for (const [code, where] of [
      ["MK3008", "ownership.mk:7:18"],
      ["MK3001", "ownership.mk:13:11"],
      ["MK3010", "ownership.mk:16:10"],
      ["MK3002", "ownership.mk:22:18"],
      ["MK3007", "ownership.mk:26:10"],
    ]) {
      assert.match(res.stderr, new RegExp(`error\\[${code}\\][^\\n]*\\n\\s*--> [^\\n]*${where.replace(/\./g, "\\.")}`), code);
    }
  });

  it("reports syntax errors with a caret under the problem", () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "bad.mk"), "fn main() {\n  let x = (1 +\n}\n");
    const res = cli(["run", "bad.mk"], { cwd: dir });
    assert.equal(res.code, 1);
    assert.match(res.stderr, /error\[MK2002\]: expected an expression, found '\}'\n\s+--> bad\.mk:3:1/);
    assert.match(res.stderr, /3 \| }\n\s+\| \^/);
  });

  it("build emits TypeScript that passes `tsc --strict`", () => {
    const out = tempDir();
    const runtime = path.join(ROOT, "dist", "src", "runtime", "index.js");
    for (const file of ["example.mk", "examples/showcase.mk"]) {
      const res = cli(["build", file, "-o", out, "--runtime-import", "mk-runtime"]);
      assert.equal(res.code, 0, res.stderr);
    }
    assert.ok(existsSync(path.join(out, "lib", "stats.ts")));
    writeFileSync(path.join(out, "package.json"), '{ "type": "module" }');
    writeFileSync(
      path.join(out, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          noEmit: true,
          skipLibCheck: true,
          types: ["node"],
          typeRoots: [path.join(ROOT, "node_modules", "@types")],
          paths: { "mk-runtime": [runtime.replace(/\.js$/, ".d.ts")] },
        },
        include: ["**/*.ts"],
      }),
    );
    const tsc = path.join(ROOT, "node_modules", "typescript", "bin", "tsc");
    try {
      execFileSync(process.execPath, [tsc, "-p", out], { encoding: "utf8" });
    } catch (e) {
      assert.fail(`generated TypeScript does not type-check:\n${(e as { stdout?: string }).stdout}`);
    }
  });

  it("prints tokens and the AST", () => {
    assert.match(cli(["tokens", "example.mk"]).stdout, /2:1\s+signal\s+signal/);
    const ast = JSON.parse(cli(["ast", "example.mk"]).stdout);
    assert.equal(ast.body[0].kind, "SignalDeclaration");
  });
});

describe("URL imports", () => {
  let server: http.Server;
  let base = "";
  let requests = 0;
  const files: Record<string, string> = {
    "/lib/greet.js": 'import { shout } from "./util.js";\nimport { VERSION } from "/abs/version.js";\nexport function greet(n) { return shout("hello " + n) + " v" + VERSION; }\n',
    "/lib/util.js": "export const shout = (s) => s.toUpperCase();\n",
    "/abs/version.js": 'export const VERSION = "1.2";\n',
    "/mk/math.mk": 'import { shout } from "../lib/util.js"\nexport fn triple(x: int) -> int { return x * 3 }\nexport fn loud(s: string) -> string { return shout(s) }\n',
  };

  before(async () => {
    server = http.createServer((req, res) => {
      requests++;
      const body = files[req.url ?? ""];
      if (body === undefined) {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, { "content-type": req.url!.endsWith(".mk") ? "text/plain" : "application/javascript" }).end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("fetches, caches, rewrites and runs remote JS and MK modules", async () => {
    const dir = tempDir();
    writeFileSync(
      path.join(dir, "app.mk"),
      `import { greet } from "${base}/lib/greet.js"\nimport { triple, loud } from "${base}/mk/math.mk"\n\n` +
        'fn main() {\n  print(greet("mk"))\n  print(triple(14))\n  print(loud("remote mk"))\n}\n',
    );

    const first = await mk(["run", "app.mk"], dir);
    assert.equal(first.code, 0, first.stderr);
    assert.equal(first.stdout, "HELLO MK v1.2\n42\nREMOTE MK\n");
    assert.equal(requests, 4); // greet, util (shared), version, math.mk

    // Remote MK interfaces are honoured: `triple` is sync, `loud` (foreign call inside) is async.
    const built = readdirSync(path.join(dir, ".mk_cache", "build")).find((f) => f.startsWith("app-"))!;
    const js = readFileSync(path.join(dir, ".mk_cache", "build", built), "utf8");
    assert.match(js, /console\.log\(triple\(14\)\)/);
    assert.match(js, /console\.log\(await loud\("remote mk"\)\)/);

    const manifest = JSON.parse(readFileSync(path.join(dir, ".mk_cache", "manifest.json"), "utf8"));
    assert.deepEqual(Object.keys(manifest.entries).sort(), Object.keys(files).map((p) => base + p).sort());
    for (const entry of Object.values<{ integrity: string }>(manifest.entries)) assert.match(entry.integrity, /^sha256-[A-Za-z0-9+/]+=*$/);

    // Second run is served entirely from the cache.
    const second = await mk(["run", "app.mk"], dir);
    assert.equal(second.stdout, first.stdout);
    assert.equal(requests, 4);

    // Tampering with a cached download is detected.
    const greetEntry = manifest.entries[`${base}/lib/greet.js`];
    const cached = path.join(dir, ".mk_cache", "remote", greetEntry.file);
    writeFileSync(cached, readFileSync(cached, "utf8").replace("hello", "pwned"));
    const tampered = await mk(["run", "app.mk"], dir);
    assert.equal(tampered.code, 1);
    assert.match(tampered.stderr, /integrity check failed for .*greet\.js/);

    // --reload re-downloads and repairs the cache.
    const reloaded = await mk(["run", "app.mk", "--reload"], dir);
    assert.equal(reloaded.stdout, first.stdout, reloaded.stderr);
  });

  it("reports unreachable modules", async () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "app.mk"), `import { nope } from "${base}/missing.js"\nprint(nope)\n`);
    const res = await mk(["run", "app.mk"], dir);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /could not fetch .*missing\.js: HTTP 404/);
  });
});
