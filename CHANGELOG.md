# Changelog

## 0.1.0 (first release)

### Language

- **Implicit async.** The compiler finds every function that does I/O, directly or through a
  call. Those functions become `async`, and exactly those calls get `await`. MK source never
  contains `async` or `await`.
- **Reactive signals.** `signal` declares a reactive value. A signal whose initializer reads
  another signal becomes a cached, derived one. `effect { }` re-runs when its signals change.
- **Database built in.**
  - `model` declarations define the schema.
  - `query` supports `first`, `count`, `where`, `order by`, `limit`, `offset` and `select`.
  - `insert`, `update ... set` and `delete` work on the same models.
  - Everything compiles to SQL with bound parameters.
- **Ownership.** `consume` parameters and arguments, checked along every code path: use after
  consume, possibly-consumed variables, loops, closures, borrowed parameters, and moves into
  spawned tasks.
- **URL imports.** Downloads are cached and hash-checked, and imports inside downloaded files are
  downloaded and rewritten too. Remote `.mk` modules are supported.
- `spawn` / `join` tasks, lambdas, `"${interpolation}"`, ranges, `let` / `var`, and gradual
  static types.

### Tooling

- The CLI has `mk run`, `mk build` (TypeScript or JavaScript output), `mk check`, `mk ast` and
  `mk tokens`.
- Error messages show the source line with a caret, a note, and a suggested fix.
- The runtime has no dependencies. It includes signals, a query builder, an in-memory database and
  a SQLite adapter (via `node:sqlite`).
- A browser playground with live compilation, a run button and share links.
- Syntax highlighting for VS Code.
