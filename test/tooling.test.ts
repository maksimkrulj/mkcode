import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { CLI, ROOT, cli, tempDir } from "./helpers.js";

describe("mk test", () => {
  it("runs every example with test blocks and passes", () => {
    const res = cli(["test", "examples"]);
    assert.equal(res.code, 0, res.stdout + res.stderr);
    assert.match(res.stdout, /shapes\.mk[\s\S]*2 passed, 0 failed/);
    assert.match(res.stdout, /todo-api\.mk[\s\S]*4 passed, 0 failed/);
  });

  it("exits non-zero when a test fails and supports --filter", () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "t.mk"), 'test "good" {\n  assert 1 == 1\n}\ntest "bad" {\n  assert 1 == 2\n}\n');
    const all = cli(["test", "t.mk"], { cwd: dir });
    assert.equal(all.code, 1);
    assert.match(all.stdout, /1 passed, 1 failed/);
    const only = cli(["test", "t.mk", "--filter", "good"], { cwd: dir });
    assert.equal(only.code, 0);
    assert.match(only.stdout, /1 passed, 0 failed/);
  });
});

describe("mk db migrate", () => {
  it("plans, applies and then has nothing left to do", () => {
    const db = path.join(tempDir(), "todos.sqlite");
    const dry = cli(["db", "migrate", "examples/todo-api.mk", "--db", db, "--dry-run"]);
    assert.match(dry.stdout, /CREATE TABLE "Todo" \("id" INTEGER PRIMARY KEY, "title" TEXT NOT NULL, "done" INTEGER NOT NULL\);/);
    assert.match(dry.stdout, /dry run/);
    assert.match(cli(["db", "migrate", "examples/todo-api.mk", "--db", db]).stdout, /applied 1 statement/);
    assert.match(cli(["db", "migrate", "examples/todo-api.mk", "--db", db]).stdout, /already matches 1 model/);
  });
});

describe("mk serve", () => {
  it("serves routes over HTTP", async () => {
    const port = 41000 + Math.floor(Math.random() * 2000);
    const child = spawn(process.execPath, [CLI, "serve", "examples/todo-api.mk", "--port", String(port)], { cwd: ROOT, env: { ...process.env, NO_COLOR: "1" } });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("server did not start")), 15000);
        child.stdout.on("data", (d: Buffer) => {
          if (d.toString().includes("listening")) {
            clearTimeout(timer);
            resolve();
          }
        });
        child.on("exit", () => reject(new Error("server exited")));
      });
      const base = `http://localhost:${port}`;
      const created = await fetch(`${base}/todos`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "over http" }) });
      assert.equal(created.status, 200);
      assert.deepEqual(await created.json(), { id: 1, title: "over http", done: false });
      assert.equal((await fetch(`${base}/todos/abc`)).status, 400);
      const page = await (await fetch(`${base}/`)).text();
      assert.match(page, /<li class="open">over http<\/li>/);
    } finally {
      child.kill();
    }
  });
});

describe("mk lsp", () => {
  it("publishes diagnostics and answers hover requests", async () => {
    const child = spawn(process.execPath, [CLI, "lsp"], { cwd: ROOT });
    const messages: any[] = [];
    // Content-Length counts bytes, so frame on the raw buffer, not on decoded text.
    let buffer = Buffer.alloc(0);
    child.stdout.on("data", (d: Buffer) => {
      buffer = Buffer.concat([buffer, d]);
      for (;;) {
        const headerEnd = buffer.indexOf("\r\n\r\n");
        if (headerEnd < 0) return;
        const length = Number(/Content-Length: (\d+)/.exec(buffer.subarray(0, headerEnd).toString())![1]);
        const start = headerEnd + 4;
        if (buffer.length < start + length) return;
        messages.push(JSON.parse(buffer.subarray(start, start + length).toString("utf8")));
        buffer = buffer.subarray(start + length);
      }
    });
    const send = (msg: object) => {
      const body = JSON.stringify({ jsonrpc: "2.0", ...msg });
      child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    };
    const waitFor = async (pred: (m: any) => boolean) => {
      for (let i = 0; i < 100; i++) {
        const hit = messages.find(pred);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error("no matching LSP message");
    };
    try {
      const uri = "file:///demo.mk";
      const text = "fn load() -> int {\n  sleep(1)\n  return 1\n}\nfn main() {\n  let x: string = load()\n}\n";
      send({ id: 1, method: "initialize", params: { capabilities: {} } });
      const init = await waitFor((m) => m.id === 1);
      assert.equal(init.result.capabilities.hoverProvider, true);
      send({ method: "textDocument/didOpen", params: { textDocument: { uri, languageId: "mk", version: 1, text } } });
      const diag = await waitFor((m) => m.method === "textDocument/publishDiagnostics");
      assert.equal(diag.params.diagnostics[0].code, "MK3104");
      assert.deepEqual(diag.params.diagnostics[0].range.start, { line: 5, character: 18 });
      send({ id: 2, method: "textDocument/hover", params: { textDocument: { uri }, position: { line: 5, character: 20 } } });
      const hover = await waitFor((m) => m.id === 2);
      assert.match(hover.result.contents.value, /fn load\(\) -> int/);
      assert.match(hover.result.contents.value, /performs I\/O/);
      send({ id: 3, method: "textDocument/definition", params: { textDocument: { uri }, position: { line: 5, character: 20 } } });
      const def = await waitFor((m) => m.id === 3);
      assert.deepEqual(def.result.range.start, { line: 0, character: 3 });
    } finally {
      child.kill();
    }
  });
});

describe("generated TypeScript for the new examples", () => {
  it("passes tsc --strict", () => {
    const out = tempDir();
    const runtime = path.join(ROOT, "dist", "src", "runtime", "index.d.ts");
    for (const file of ["shapes", "todo-api", "leaderboard", "counter"]) {
      const res = cli(["build", `examples/${file}.mk`, "-o", out, "--runtime-import", "mk-runtime"]);
      assert.equal(res.code, 0, res.stderr);
    }
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
          paths: { "mk-runtime": [runtime] },
        },
        include: ["**/*.ts"],
      }),
    );
    try {
      execFileSync(process.execPath, [path.join(ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", out], { encoding: "utf8" });
    } catch (e) {
      assert.fail(`generated TypeScript does not type-check:\n${(e as { stdout?: string }).stdout}`);
    }
  });
});
