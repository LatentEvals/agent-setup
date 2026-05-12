// Content hash of a directory tree.
//
// Used by `import` to compare skill directories across harness sources and
// against existing `.agents/skills/<name>/`. Two trees hash equal iff their
// relative paths and file bytes are identical.

import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

async function walk(dir: string, prefix: string, out: string[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const rel = prefix === "" ? e.name : `${prefix}/${e.name}`;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) {
      await walk(abs, rel, out);
    } else if (e.isFile()) {
      out.push(rel);
    } else if (e.isSymbolicLink()) {
      const target = await fs.stat(abs).catch(() => null);
      if (target && target.isFile()) out.push(rel);
      // Skip dangling symlinks; they're not content.
    }
  }
}

export async function hashDir(dir: string): Promise<string> {
  const rels: string[] = [];
  await walk(dir, "", rels);
  rels.sort();
  const h = createHash("sha256");
  for (const rel of rels) {
    h.update(rel);
    h.update("\0");
    const bytes = await fs.readFile(path.join(dir, rel));
    h.update(bytes);
    h.update("\0");
  }
  return h.digest("hex");
}
