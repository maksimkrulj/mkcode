# Changelog

## 0.2.0: full stack

### Language

- **Enums and `match`.**
  - `enum Shape { Circle(radius: float), Empty }` declares a tagged union.
  - `match` supports nested patterns, guards (`x if x > 0`), literals and `_`.
  - The compiler checks that every case is handled (MK3703).
- **`Result<T, E>` and `?`.** `Ok(v)` and `Err(e)` build results. `expr?` returns the error early.
  It compiles to a plain `if` and `return`, not to exceptions.
- **Null narrowing.** After `if x == null { return }`, the compiler treats `x` as non-null.
- **Pipelines.** `a |> f(b)` means `f(a, b)`. New collection built-ins: `map`, `filter`,
  `reduce`, `each`, `find`, `some`, `every`, `sortBy`, `sum`, `take`. When the function you pass
  does I/O, `map` and `filter` run it concurrently, and the others keep going in order.
- **Live queries.** `signal x = live query ...` re-runs when the signals in its `where` change, or
  when its table is written.
- **Routes.** `route GET "/todos/:id" (id: int) -> Todo? { ... }` declares an HTTP endpoint.
  - Parameters are checked and converted, so a bad value gets a `400`.
  - `null` becomes `404`, `Err` becomes `400`, and markup becomes an HTML response.
  - `request(method, path, body)` calls your routes in-process.
- **Views.** `view Counter(start: int) { ... <div>{count}</div> }` declares a component.
  - Markup with `{expressions}`, `on:event` handlers and `bind:value` two-way binding.
  - In the browser, only the parts that depend on a changed signal are updated. On the server,
    views render to HTML.
- **Tests.** `test "name" { assert a == b }` blocks run against a fresh database each. Failures
  show the left and right values.
- New checks:
  - a query column compared with itself (MK3308, warning)
  - `match` or `?` used where it would only run sometimes (MK3705)
  - view props (MK4002), bindings (MK4003) and I/O inside markup (MK4001)

### Tooling

- `mk serve [--watch]`, `mk test [path] [--filter]` and `mk db migrate --db file.sqlite
  [--dry-run] [--allow-drop]`.
- `mk lsp`: a language server with diagnostics, hover (inferred types and async-ness), go to
  definition, document outline and completion.
- The VS Code extension now starts the language server, and its highlighting covers markup,
  `match` and `|>`.
- Playground: a **Preview** tab that renders views live, a **✓ Test** button, and new examples.
- The animated README demo (`assets/demo.svg`) is generated from real compiler output.
- The npm package is now named `mkcode`, so `npx mkcode run app.mk` works once it's published.

## 0.1.0: first release

- Implicit async, signals and effects, `model`, `query`, `insert`, `update`, `delete`, `consume`
  ownership, URL imports with an integrity-checked cache.
- CLI (`run`, `build`, `check`, `ast`, `tokens`), a runtime with no dependencies (in-memory and
  SQLite storage), browser playground, VS Code highlighting.
