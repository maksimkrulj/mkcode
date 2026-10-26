/**
 * MK's static types. The checker is gradual: `any` is compatible with everything,
 * so code that touches untyped JavaScript still compiles, while fully annotated MK
 * code gets real checks.
 */
export type Type =
  | { kind: "int" }
  | { kind: "float" }
  | { kind: "string" }
  | { kind: "bool" }
  | { kind: "void" }
  | { kind: "null" }
  | { kind: "any" }
  | { kind: "list"; element: Type }
  | { kind: "map"; key: Type; value: Type }
  | { kind: "optional"; inner: Type }
  | { kind: "task"; inner: Type }
  | { kind: "fn"; params: Type[]; returns: Type }
  | { kind: "model"; name: string }
  | { kind: "named"; name: string; args: Type[] };

export const INT: Type = { kind: "int" };
export const FLOAT: Type = { kind: "float" };
export const STRING: Type = { kind: "string" };
export const BOOL: Type = { kind: "bool" };
export const VOID: Type = { kind: "void" };
export const NULL: Type = { kind: "null" };
export const ANY: Type = { kind: "any" };

export const list = (element: Type): Type => ({ kind: "list", element });
export const optional = (inner: Type): Type =>
  inner.kind === "optional" || inner.kind === "any" || inner.kind === "null" ? inner : { kind: "optional", inner };

export function isNumeric(t: Type): boolean {
  return t.kind === "int" || t.kind === "float";
}

/** True when the checker knows nothing useful about `t`. */
export function isUnknown(t: Type): boolean {
  return t.kind === "any" || t.kind === "named";
}

export function typeToString(t: Type): string {
  switch (t.kind) {
    case "list":
      return `List<${typeToString(t.element)}>`;
    case "map":
      return `Map<${typeToString(t.key)}, ${typeToString(t.value)}>`;
    case "optional":
      return `${typeToString(t.inner)}?`;
    case "task":
      return `Task<${typeToString(t.inner)}>`;
    case "fn":
      return `fn(${t.params.map(typeToString).join(", ")}) -> ${typeToString(t.returns)}`;
    case "model":
      return t.name;
    case "named":
      return t.args.length ? `${t.name}<${t.args.map(typeToString).join(", ")}>` : t.name;
    default:
      return t.kind;
  }
}

/** Can a value of type `from` be stored where `to` is expected? */
export function isAssignable(from: Type, to: Type): boolean {
  if (from.kind === "any" || to.kind === "any") return true;
  // Named types come from outside MK (host classes, imported types): only compare them with each other.
  if (from.kind === "named" || to.kind === "named") {
    return from.kind === "named" && to.kind === "named" ? from.name === to.name : true;
  }
  if (to.kind === "optional") {
    return from.kind === "null" || isAssignable(from.kind === "optional" ? from.inner : from, to.inner);
  }
  switch (from.kind) {
    case "int":
      return to.kind === "int" || to.kind === "float";
    case "list":
      return to.kind === "list" && isAssignable(from.element, to.element);
    case "map":
      return to.kind === "map" && isAssignable(from.key, to.key) && isAssignable(from.value, to.value);
    case "task":
      return to.kind === "task" && isAssignable(from.inner, to.inner);
    case "fn":
      return to.kind === "fn";
    case "model":
      return to.kind === "model" && to.name === from.name;
    case "optional":
      return false;
    default:
      return from.kind === to.kind;
  }
}

/** Could `a == b` ever be true? Used to flag comparisons between unrelated primitives. */
export function isComparable(a: Type, b: Type): boolean {
  const strip = (t: Type) => (t.kind === "optional" ? t.inner : t);
  if (a.kind === "null" || b.kind === "null") return true;
  const x = strip(a);
  const y = strip(b);
  if (isUnknown(x) || isUnknown(y)) return true;
  if (isNumeric(x) && isNumeric(y)) return true;
  return isAssignable(x, y) || isAssignable(y, x);
}
