// Same shape as formats/json.ts, but for TOML round-trips via smol-toml.
//
// LIMITATION: smol-toml's `stringify` does not preserve comments or
// formatting from the source file. We accept that for v0.1 — config
// files our reconciler manages are typically machine-managed already.
// Future work: switch to a comment-preserving TOML library or limit
// our writes to a smaller surgical text rewrite when comments are
// present.

import { parse as tomlParse, stringify as tomlStringify } from "smol-toml";

function splitPointer(pointer: string): string[] {
  if (pointer.length === 0) return [];
  return pointer.split(/[./]/g).filter((s) => s.length > 0);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function getAtPointer(value: unknown, pointer: string): unknown {
  const segs = splitPointer(pointer);
  let cur: unknown = value;
  for (const seg of segs) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[seg];
  }
  return cur;
}

export function setAtPointer(
  value: unknown,
  pointer: string,
  newValue: unknown,
): Record<string, unknown> {
  const segs = splitPointer(pointer);
  const root: Record<string, unknown> = isPlainObject(value) ? { ...value } : {};
  if (segs.length === 0) {
    if (!isPlainObject(newValue)) {
      throw new Error("setAtPointer with empty pointer requires an object");
    }
    return { ...newValue };
  }
  let cur: Record<string, unknown> = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i] as string;
    const next = cur[seg];
    const nextCopy: Record<string, unknown> = isPlainObject(next)
      ? { ...next }
      : {};
    cur[seg] = nextCopy;
    cur = nextCopy;
  }
  const last = segs[segs.length - 1] as string;
  cur[last] = newValue;
  return root;
}

export function deleteAtPointer(value: unknown, pointer: string): unknown {
  const segs = splitPointer(pointer);
  if (segs.length === 0) return value;
  if (!isPlainObject(value)) return value;
  const root: Record<string, unknown> = { ...value };
  let cur: Record<string, unknown> = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i] as string;
    const next = cur[seg];
    if (!isPlainObject(next)) return root;
    const nextCopy: Record<string, unknown> = { ...next };
    cur[seg] = nextCopy;
    cur = nextCopy;
  }
  const last = segs[segs.length - 1] as string;
  delete cur[last];
  return root;
}

export function parseToml(text: string): Record<string, unknown> {
  const parsed = tomlParse(text);
  if (!isPlainObject(parsed)) {
    throw new Error("toml document must be a table at top level");
  }
  return parsed;
}

export function stringifyToml(value: Record<string, unknown>): string {
  return tomlStringify(value);
}
