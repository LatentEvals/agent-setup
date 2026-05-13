// Shared filesystem helpers for the `import` verb's sub-orchestrators.

import path from "node:path";
import { promises as fs } from "node:fs";

export function resolveXdgConfigHome(root: string): string {
  const xdg = process.env["XDG_CONFIG_HOME"];
  return xdg && xdg.length > 0 ? xdg : path.join(root, ".config");
}

export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function readDirSafe(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw e;
  }
}

export async function readFileOrNull(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, "utf-8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EISDIR") return null;
    throw e;
  }
}
