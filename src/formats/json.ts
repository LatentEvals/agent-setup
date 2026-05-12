// Pure helpers for navigating/mutating parsed JSON values by dotted pointer.
//
// Pointer syntax: dot-delimited keys (e.g. "mcpServers.neon"). We chose
// dots over RFC 6901 slashes because none of our keys can legitimately
// contain dots (server names are [a-z0-9-]) or slashes, but dots are
// friendlier to read in code and lockfile output. Forward slashes are
// also accepted as a convenience.
//
// All mutators return a new top-level object — the input is untouched.

function splitPointer(pointer: string): string[] {
  // Accept either dots or forward slashes as separators. Empty pointer
  // means "the whole value".
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
): unknown {
  const segs = splitPointer(pointer);
  if (segs.length === 0) return newValue;
  const root: Record<string, unknown> = isPlainObject(value) ? { ...value } : {};
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
    if (!isPlainObject(next)) return root; // nothing to delete
    const nextCopy: Record<string, unknown> = { ...next };
    cur[seg] = nextCopy;
    cur = nextCopy;
  }
  const last = segs[segs.length - 1] as string;
  delete cur[last];
  return root;
}

// V8/Node ≥12 already preserves key insertion order for string keys, so a
// plain JSON.stringify already produces stable output. We append a
// trailing newline for POSIX-friendliness.
export function stringifyJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}
