<p align="center">
  <img src="assets/logo.svg" width="112" alt="MK logo">
</p>

<h1 align="center">MK</h1>

<p align="center">
  <b>Write it like a script. Ship it as TypeScript.</b><br>
  A reactive, database-native language with implicit async and compile-time ownership,<br>
  that compiles to clean, readable TypeScript.
</p>

<p align="center">
  <a href="https://github.com/maksimkrulj/mkcode/actions/workflows/ci.yml"><img src="https://github.com/maksimkrulj/mkcode/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-8b5cf6" alt="MIT license"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A5%2022.13-06b6d4" alt="Node 22.13+">
  <img src="https://img.shields.io/badge/runtime%20dependencies-0-34d399" alt="Zero runtime dependencies">
  <a href="https://maksimkrulj.github.io/mkcode/"><img src="https://img.shields.io/badge/try%20it-playground-f59e0b" alt="Playground"></a>
  <a href="CONTRIBUTING.md"><img src="https://img.shields.io/badge/PRs-welcome-ec4899" alt="PRs welcome"></a>
</p>

<p align="center">
  <a href="https://maksimkrulj.github.io/mkcode/"><b>▶ Try it in your browser</b></a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#the-language">Language tour</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#roadmap">Roadmap</a>
</p>

---

<table>
<tr>
<th>You write MK…</th>
<th>…and get TypeScript you'd be happy to commit</th>
</tr>
<tr>
<td valign="top">

```rust
signal score = 100
signal doubleScore = score * 2

fn getActiveUsers(minScore: int) -> List<User> {
    return query User
        where score >= minScore
        order by score desc
}

fn processData(consume payload: Buffer) {
    print("Processing buffer...")
}

fn main() {
    let buf = Buffer.alloc(1024)
    processData(consume buf)

    let top = getActiveUsers(50)
    print("Top users:", top)
}
```

</td>
<td valign="top">

```ts
const score = $mk.signal(100);
const doubleScore = $mk.computed(() => score.value * 2);

async function getActiveUsers(minScore: number): Promise<User[]> {
  return await $mk.db
    .from(User)
    .where($mk.q.gte($mk.q.col("score"), minScore))
    .orderBy("score", "desc")
    .all();
}

function processData(payload: Buffer) {
  console.log("Processing buffer...");
}

async function main() {
  const buf = Buffer.alloc(1024);
  processData(buf);

  const top = await getActiveUsers(50);
  console.log("Top users:", top);
}

await main();
```

</td>
</tr>
</table>

The MK side never mentions `async`, `await`, an ORM, or a reactivity library. The compiler worked
out that `getActiveUsers` does I/O and `processData` doesn't, and placed `await` only where it is
needed. It also checked that `buf` is never touched after being handed off. The output passes
`tsc --strict`.

## Why MK?

| | |
| --- | --- |
| ⚡ **No `async`/`await` anywhere** | The compiler finds every function that does I/O (directly or through a call) and adds `async` and `await` only there. No function coloring in your code. |
| 🔁 **Reactivity is syntax** | `signal`, derived signals and `effect { }` are part of the grammar. Reads and writes compile to a tiny signal runtime with no dependencies. |
| 🗄️ **The database is part of the language** | `query User where score >= min order by score desc`, plus `insert`, `update` and `delete`. All of it compiles to SQL with bound parameters and is checked against your `model` schema. |
| 🔒 **Ownership, checked before you run** | `consume` moves a value. Using it afterwards on *any* path, in a loop, or from a closure is a compile error. The check costs nothing at runtime. |
| 🌐 **Import straight from a URL** | `import { x } from "https://…"` downloads the file, caches it in `.mk_cache`, records its SHA-256 hash, and works offline after that. |

## Error messages are part of the design

```text
error[MK3001]: use of consumed variable 'buf'
  --> examples/errors/ownership.mk:13:11
   |
13 |     print(buf.length)           // MK3001: use after consume
   |           ^^^
   = note: 'buf' was consumed here and can no longer be used (12:10)

error[MK3303]: model 'User' has no column 'nme' — did you mean 'name'?
 --> app.mk:8:46
  |
8 |     let r = query User where active order by nme
  |                                              ^^^
```

Every error has a stable code, the exact line and column, a note pointing at the related place,
and a suggested fix when one is clear.

## Quick start

```bash
git clone https://github.com/maksimkrulj/mkcode.git
cd mkcode
npm install
npm run build
node bin/mk.js run example.mk --seed examples/users.seed.json
```

Run `npm link` to put `mk` on your PATH. To skip installing anything, open the
**[playground](https://maksimkrulj.github.io/mkcode/)**: it compiles as you type, runs your program,
and gives you a share link.

| Command | What it does |
| --- | --- |
| `mk run app.mk` | Compile the file and its imports, then run it (`--runtime bun` to use Bun) |
| `mk build app.mk -o out` | Write TypeScript (or `--target js`), keeping the source folder layout |
| `mk check app.mk` | Run the type and ownership checks only |
| `mk ast app.mk` · `mk tokens app.mk` | Print the syntax tree or the token stream |

Options for `run`:

- `--seed data.json`: preload the database
- `--db app.sqlite`: use a real SQLite file
- `--debug-sql`: print every statement
- `--reload`: download URL imports again

## The language

### Implicit async

```rust
fn slow(label: string) -> string {
    sleep(20)                              // I/O, so slow() becomes async
    return label
}

fn main() {
    let task = spawn slow("background")    // starts running; main keeps going
    print(slow("first"))                   // awaited automatically
    print(join(task))                      // wait for the task's result
}
```

The compiler builds a call graph and marks a function async if it does I/O itself or calls
something that does. These count as I/O:

- `query`, `insert`, `update`, `delete`
- `sleep`, `fetch`, `fetchJson`, `fetchText`, `readFile`, `writeFile`, `join`
- calls into non-MK modules

The analysis works across files: when you import an MK module, the compiler reads which of its
exports are async.

### Signals

```rust
signal threshold = 60
signal label = "threshold is ${threshold}"   // derived: computed lazily and cached
effect { print(label) }                      // prints "threshold is 60"
threshold = 50                               // the effect prints "threshold is 50"
```

You read and assign signals like normal variables. Assigning to a derived signal (MK3202) or doing
I/O inside one (MK3204) is a compile error.

### Database

```rust
model User {
    id: int
    name: string
    score: int
    email: string?
}

let top   = query User where score >= min && name.startsWith("A") order by score desc limit 10
let one   = query first User where id == userId           // User?
let n     = query count User where email == null          // int, compiled to IS NULL
let row   = insert User { name: "Ana", score: 92 }
let bumps = update User set score = score + 5 where score < 70
let gone  = delete User where email == null
```

Values always become bound parameters, so SQL injection isn't possible through a query. Inside a
query, a column name hides any variable with the same name, as in SQL.

When a model is declared, the compiler checks every query against it: unknown columns, wrong types
and missing insert fields are compile errors, and misspelled columns get a "did you mean" hint.

There are three storage backends:

- **In memory** (the default).
- **SQLite** through Node's built-in `node:sqlite` (`--db app.sqlite`). Tables are created from
  your models.
- **Your own database**: `db.use(new SqlAdapter("postgres", driver))`.

A test runs the same set of queries on both the in-memory and SQLite backends and checks that the
results match.

### Ownership with `consume`

| Code | Rule |
| --- | --- |
| MK3001 | A variable is used after it was consumed, in the same block or a nested one |
| MK3002 | A variable is used after a branch that might have consumed it |
| MK3006 / MK3007 | A variable is consumed inside a closure, or consumed while a closure still uses it |
| MK3008 | A borrowed parameter is consumed (declare it `consume p: T` instead) |
| MK3009 | A variable from outside a loop is consumed inside the loop |
| MK3010 | A variable is passed to a `consume` parameter without writing `consume` |

Some patterns are allowed:

- Passing a temporary value, such as `send(Buffer.alloc(8))`, needs no `consume`.
- Assigning a new value to a `var` makes it usable again.
- A `spawn`ed task can take ownership of a variable, because it runs exactly once.
- If a branch consumes a variable and then returns, the code after the branch can still use it.

### URL imports

```rust
import { nanoid } from "https://cdn.jsdelivr.net/npm/nanoid@5.0.9/index.browser.js"
import { triple } from "https://example.com/lib/math.mk"
```

Each download is cached and recorded with its SHA-256 hash in `.mk_cache/manifest.json`. A cached
file that was changed is rejected; `--reload` downloads it again. Imports inside downloaded files
are downloaded and rewritten too. Remote `.mk` files are compiled like local ones.

### Everything else

- `let` declares an immutable binding and `var` a mutable one.
- Types: `int`, `float`, `string`, `bool`, `List<T>`, `Map<K,V>`, `T?`, `fn(A) -> B`, `Task<T>`.
- `if` / `else`, `while`, `for x in list`, `for i in 0..n`.
- Lambdas `fn(x) => x * 2` and string interpolation `"Hi ${name}"`.
- The type checker is gradual: annotated MK code gets checked for arity, argument and return
  types, missing returns, conditions and impossible comparisons. Untyped JavaScript passes
  through as `any`.

## How it works

```
.mk ─▶ Lexer ─▶ Parser ─▶ Analyzer ─────────────────────▶ CodeGenerator ─▶ .ts / .mjs
        │         │          ├ scopes & gradual types           ├ readable TS, comments kept
     tokens +  AST with      ├ ownership tracked on every path  ├ async/await placed exactly
     comments  error         ├ async fixpoint over call graph   └ parameterized query builders
               recovery      └ query column vs. value analysis
```

| Path | Role |
| --- | --- |
| `src/lexer/` | `TokenType` enum and `Lexer`. Newlines end statements, except inside `()` and `[]`. Handles string interpolation. |
| `src/parser/` | Recursive-descent parser with contextual keywords. Reports errors with line and column, then recovers and keeps going. |
| `src/analyzer/` | Symbol tables, gradual types, ownership checking, async inference, query checks |
| `src/codegen/` | AST → TypeScript or JavaScript, adding parentheses where precedence needs them |
| `src/runtime/` | The `$mk` runtime with no dependencies: signals, query IR → SQL (sqlite and postgres), memory and SQLite adapters |
| `src/cli/` | The `mk` command, multi-module builds, and the URL import cache |
| `playground/` | The browser playground, running the real compiler from `dist/` |
| `editors/vscode/` | VS Code syntax highlighting |

All 90 tests run in CI on Linux, macOS and Windows, with Node 22 and 24. They include a test that
runs the generated TypeScript through `tsc --strict`.

## Editor support

**VS Code**: see [`editors/vscode`](editors/vscode). It provides highlighting for signals,
queries, `consume` and string interpolation, plus bracket and indentation rules.

## Roadmap

- [x] Lexer, parser, analyzer, code generator, CLI
- [x] Signals, queries, ownership, implicit async, URL imports
- [x] Browser playground and VS Code highlighting
- [ ] `try` / `catch` and typed errors
- [ ] Language server: hover types, go to definition, diagnostics while you type
- [ ] Async-aware higher-order functions (`list.map(fn(x) => query ...)`)
- [ ] Postgres adapter out of the box
- [ ] `enum` and `match`
- [ ] Moving individual fields with `consume`
- [ ] `npx mk-lang run app.mk` (npm release)

Want to build one of these? See **[CONTRIBUTING.md](CONTRIBUTING.md)**. Every stage of the
compiler is small and has its own tests.

## Known limitations

- Async detection only sees calls it can resolve. An async lambda passed to a host method such as
  `list.map` gives you back a list of promises.
- An `effect` only tracks the signals it reads before its first I/O call.
- MK has no `try`/`catch` yet. `panic(msg)` throws.
- In `select a, b` and `order by a, b`, the commas are read greedily. When you pass such a query as
  an argument, wrap it in parentheses.

---

<p align="center">
  If MK made you think <i>"why isn't TypeScript like this?"</i>, consider giving it a ⭐<br>
  It helps other people find the project.
</p>

<p align="center">
  <a href="https://star-history.com/#maksimkrulj/mkcode&Date">
    <img src="https://api.star-history.com/svg?repos=maksimkrulj/mkcode&type=Date" width="560" alt="Star history">
  </a>
</p>

<p align="center"><sub>MIT © maksimkrulj</sub></p>
