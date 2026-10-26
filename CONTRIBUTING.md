# Contributing to MK

Thanks for your interest! MK is young, so this is a good time to help shape it. You can report a
confusing error message, add a test, or propose new syntax.

## Setup

```bash
git clone https://github.com/maksimkrulj/mkcode.git
cd mkcode
npm install
npm test              # builds with tsc, then runs every test
npm run playground    # builds and serves the browser playground at http://localhost:5173
```

You need Node.js 22.13 or newer. The SQLite tests use the built-in `node:sqlite` module.

## How the compiler is organized

A language change usually touches these stages, in this order:

| Stage | File | What to add |
| --- | --- | --- |
| Tokens | `src/lexer/Token.ts`, `src/lexer/Lexer.ts` | New keywords or operators. Prefer *contextual* keywords (see `CONTEXTUAL_KEYWORDS`) so you don't break existing identifiers. |
| Syntax | `src/ast/nodes.ts`, `src/parser/Parser.ts` | An AST node and a parse rule. Every node needs a correct `span`. |
| Meaning | `src/analyzer/Analyzer.ts` | Name resolution, type checks, ownership and async effects for the new construct |
| Output | `src/codegen/CodeGenerator.ts` | Readable TypeScript. Write it the way a person would. |
| Runtime | `src/runtime/` | Only if the construct needs runtime support. Keep the runtime free of dependencies. |

Each stage has its own test file in `test/`. A new feature should come with at least one parser
test, one analyzer test (including the error cases) and one codegen test. Add an end-to-end test
in `test/codegen.test.ts` ("Generated programs run") if the feature changes runtime behavior.

## Diagnostics

Error codes are grouped by stage, and each code is used for one thing only:

- `MK1xxx`: lexer
- `MK2xxx`: parser
- `MK30xx`: ownership (`consume`)
- `MK31xx`: types
- `MK32xx`: signals and async
- `MK33xx`: queries
- `MK34xx`: names and scopes
- `MK35xx`: modules
- `MK36xx`: warnings

A good error message:

- says what is wrong, using the user's own names
- points at the narrowest span that makes sense
- adds a `note` pointing at the related place (for example, where a variable was consumed)
- suggests a fix when one is clear ("write `consume buf`", "did you mean `name`?")

## Pull requests

- Keep each PR to one change. Small PRs get reviewed fast.
- `npm test` must pass. CI runs it on Linux, macOS and Windows with Node 22 and 24.
- If you change the language, update the README section that describes it.

## Good first issues

- More "did you mean" hints, for example for misspelled keywords
- New built-ins in `src/analyzer/builtins.ts` and `src/runtime/index.ts`
- Syntax highlighting for more editors (see `editors/vscode` for the TextMate grammar)
- More playground examples in `playground/examples.js`
