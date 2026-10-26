import { ANY, BOOL, FLOAT, INT, STRING, VOID, list, type Type } from "./types.js";

export interface Builtin {
  name: string;
  kind: "function" | "value";
  /** Performs I/O: calls are awaited and make the caller implicitly async. */
  async: boolean;
  /** JavaScript emitted in place of the name. `$mk.` refers to the MK runtime. */
  emit: string;
  type: Type;
  minArgs?: number;
  /** `undefined` means variadic. */
  maxArgs?: number;
  /**
   * Takes a function argument. If that function performs I/O the call is awaited and the
   * runtime runs it concurrently (`map`, `filter`) or in order (`each`, `reduce`).
   */
  higherOrder?: boolean;
}

const fn = (
  name: string,
  emit: string,
  returns: Type,
  args: [min: number, max: number | undefined],
  async = false,
): Builtin => ({
  name,
  kind: "function",
  async,
  emit,
  type: { kind: "fn", params: [], returns },
  minArgs: args[0],
  maxArgs: args[1],
});

const hof = (name: string, returns: Type, args: [number, number]): Builtin => ({
  ...fn(name, `$mk.${name}`, returns, args),
  higherOrder: true,
});

const value = (name: string, emit = name): Builtin => ({
  name,
  kind: "value",
  async: false,
  emit,
  type: { kind: "named", name, args: [] },
});

/** Names available in every MK module without an import. */
export const BUILTINS: ReadonlyMap<string, Builtin> = new Map(
  [
    fn("print", "console.log", VOID, [0, undefined]),
    fn("len", "$mk.len", INT, [1, 1]),
    fn("str", "String", STRING, [1, 1]),
    fn("int", "$mk.toInt", INT, [1, 1]),
    fn("float", "Number", FLOAT, [1, 1]),
    fn("now", "Date.now", INT, [0, 0]),
    fn("panic", "$mk.panic", VOID, [0, 1]),
    fn("keys", "Object.keys", list(STRING), [1, 1]),
    fn("untrack", "$mk.untrack", ANY, [1, 1]),
    fn("batch", "$mk.batch", ANY, [1, 1]),
    fn("isNull", "$mk.isNull", BOOL, [1, 1]),
    // Implicitly asynchronous I/O
    fn("sleep", "$mk.sleep", VOID, [1, 1], true),
    fn("fetch", "$mk.fetch", ANY, [1, 2], true),
    fn("fetchJson", "$mk.fetchJson", ANY, [1, 2], true),
    fn("fetchText", "$mk.fetchText", STRING, [1, 2], true),
    fn("readFile", "$mk.readFile", STRING, [1, 1], true),
    fn("writeFile", "$mk.writeFile", VOID, [2, 2], true),
    fn("join", "$mk.join", ANY, [1, undefined], true),
    fn("request", "$mk.http.request", ANY, [2, 3], true),
    fn("serve", "$mk.http.serve", VOID, [0, 1], true),
    fn("mount", "$mk.mount", VOID, [1, 2]),
    fn("renderToString", "$mk.renderToString", STRING, [1, 1]),
    fn("Ok", "$mk.Ok", ANY, [0, 1]),
    fn("Err", "$mk.Err", ANY, [1, 1]),
    // Collections — usable with `|>`; async-aware when given a function that does I/O
    hof("map", ANY, [2, 2]),
    hof("filter", ANY, [2, 2]),
    hof("reduce", ANY, [3, 3]),
    hof("each", VOID, [2, 2]),
    hof("find", ANY, [2, 2]),
    hof("some", BOOL, [2, 2]),
    hof("every", BOOL, [2, 2]),
    hof("sortBy", ANY, [2, 2]),
    fn("sum", "$mk.sum", ANY, [1, 1]),
    fn("take", "$mk.take", ANY, [2, 2]),
    // Host globals
    value("Buffer"),
    value("Math"),
    value("JSON"),
    value("Date"),
    value("Object"),
    value("Array"),
    value("Map"),
    value("Set"),
    value("URL"),
    value("Error"),
    value("Promise"),
    value("console"),
    value("process"),
  ].map((b) => [b.name, b]),
);
