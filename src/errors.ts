// Helpers for reading thrown values, which are `unknown`: libraries throw Errors with extra fields
// (`code`, `responseCode`, `command`), and nothing guarantees a thrown value is an Error at all.

type ErrorKey = "code" | "message" | "responseCode" | "command";

/** A property of a thrown value, or undefined when it is not an object (or does not have it). */
export function errorProp(e: unknown, key: ErrorKey): unknown {
  if (typeof e !== "object" || e === null) return undefined;
  const value: unknown = Reflect.get(e, key);
  return value;
}

/** The message of a thrown value, or the value itself as text. */
export const errorText = (e: unknown): string => String(errorProp(e, "message") ?? e);

/** The first of `keys` that holds a code (string or number), for a short log line; "error" otherwise. */
export function errorCode(e: unknown, ...keys: ErrorKey[]): string {
  for (const key of keys) {
    const v = errorProp(e, key);
    if (typeof v === "string" || typeof v === "number") return String(v);
  }
  return "error";
}
