// Per-harness readers for MCP server entries.
//
// Each function reads its harness's config file, parses it with the
// appropriate format helper, and walks the harness-specific entry key,
// returning a flat list of `{ name, raw }` records. A missing file is
// not an error — it returns an empty array.

import { getAtPointer as getJsonAtPointer } from "./formats/json.js";
import { getAtPointer as getTomlAtPointer, parseToml } from "./formats/toml.js";
import { readFileOrNull } from "./import-fs.js";

export type RawMcpEntry = {
  name: string;
  raw: unknown;
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

async function readJsonFile(file: string): Promise<unknown | null> {
  const text = await readFileOrNull(file);
  if (text === null) return null;
  if (text.trim().length === 0) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`failed to parse JSON at ${file}: ${(e as Error).message}`);
  }
}

async function readTomlFile(file: string): Promise<unknown | null> {
  const text = await readFileOrNull(file);
  if (text === null) return null;
  if (text.trim().length === 0) return null;
  try {
    return parseToml(text);
  } catch (e) {
    throw new Error(`failed to parse TOML at ${file}: ${(e as Error).message}`);
  }
}

function entriesAt(
  obj: unknown,
  pointer: string,
  isToml: boolean,
): RawMcpEntry[] {
  if (obj === undefined || obj === null) return [];
  const node = isToml
    ? getTomlAtPointer(obj, pointer)
    : getJsonAtPointer(obj, pointer);
  if (!isPlainObject(node)) return [];
  const out: RawMcpEntry[] = [];
  for (const [name, raw] of Object.entries(node)) {
    out.push({ name, raw });
  }
  // Stable order — sort by name.
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export async function readClaudeMcps(file: string): Promise<RawMcpEntry[]> {
  const root = await readJsonFile(file);
  return entriesAt(root, "mcpServers", false);
}

export async function readCursorMcps(file: string): Promise<RawMcpEntry[]> {
  const root = await readJsonFile(file);
  return entriesAt(root, "mcpServers", false);
}

export async function readGeminiMcps(file: string): Promise<RawMcpEntry[]> {
  const root = await readJsonFile(file);
  return entriesAt(root, "mcpServers", false);
}

export async function readOpenCodeMcps(file: string): Promise<RawMcpEntry[]> {
  const root = await readJsonFile(file);
  return entriesAt(root, "mcp", false);
}

export async function readCodexMcps(file: string): Promise<RawMcpEntry[]> {
  const root = await readTomlFile(file);
  return entriesAt(root, "mcp_servers", true);
}
