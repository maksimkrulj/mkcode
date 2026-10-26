/** `Result<T, E>`: either `Ok(value)` or `Err(error)`. Matched with `match`, unwrapped with `?`. */
export type Result<T, E> = { tag: "Ok"; value: T } | { tag: "Err"; error: E };

export function Ok<T = void>(value?: T): Result<T, never> {
  return { tag: "Ok", value: value as T };
}

export function Err<E>(error: E): Result<never, E> {
  return { tag: "Err", error };
}

export function isResult(value: unknown): value is Result<unknown, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const tag = (value as { tag?: unknown }).tag;
  return (tag === "Ok" && "value" in value) || (tag === "Err" && "error" in value);
}
