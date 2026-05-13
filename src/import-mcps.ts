// MCP-only half of `agent-setup import`.
//
// Reads MCP server entries from per-harness config files, reverse-translates
// them into the canonical Server schema, and writes one
// `.agents/mcps/<name>.json` per discovered server. Does not write per-tool
// configs — `install` does that.

import { homedir } from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";

import type { Scope } from "./types.js";
import { ALL_TOOLS, type Tool } from "./import-sources.js";
import { resolveXdgConfigHome, pathExists, readFileOrNull } from "./import-fs.js";
import {
  readClaudeMcps,
  readCodexMcps,
  readCursorMcps,
  readGeminiMcps,
  readOpenCodeMcps,
  type RawMcpEntry,
} from "./mcp-readers.js";
import { normalizeFor, type ReverseResult } from "./mcp-reverse.js";
import { stringifyJson } from "./formats/json.js";
import type { Server } from "./schema.js";

export type McpImportOptions = {
  cwd: string;
  scope: Scope;
  from?: Tool;
  dryRun: boolean;
  force: boolean;
};

export type McpImportAction =
  | {
      kind: "copy";
      name: string;
      sources: Tool[];
      destFile: string;
    }
  | {
      kind: "noop-already-canonical";
      name: string;
      sources: Tool[];
    }
  | {
      kind: "skip-conflict";
      name: string;
      byTool: Array<{ tool: Tool; source: string; hash: string }>;
    }
  | {
      kind: "skip-existing";
      name: string;
      destFile: string;
      sources: Tool[];
    }
  | {
      kind: "overwrite";
      name: string;
      sources: Tool[];
      destFile: string;
    }
  | {
      kind: "skip-invalid";
      name: string;
      source: string;
      tool: Tool;
      reason: string;
    };

export type McpImportResult = {
  actions: McpImportAction[];
  scanned: Array<{ tool: Tool; file: string; found: string[] }>;
  targetRoot: string;
  imported: string[];
  skipped: string[];
};

type SourceFile = { tool: Tool; file: string };

function mcpSourceFilesFor(
  scope: Scope,
  root: string,
  xdgConfigHome: string,
  fromFilter?: Tool,
): SourceFile[] {
  const tools = fromFilter ? [fromFilter] : ALL_TOOLS;
  const out: SourceFile[] = [];
  for (const tool of tools) {
    out.push({ tool, file: fileFor(tool, scope, root, xdgConfigHome) });
  }
  return out;
}

function fileFor(
  tool: Tool,
  scope: Scope,
  root: string,
  xdgConfigHome: string,
): string {
  switch (tool) {
    case "claude":
      return scope === "project"
        ? path.join(root, ".mcp.json")
        : path.join(root, ".claude.json");
    case "codex":
      return path.join(root, ".codex", "config.toml");
    case "cursor":
      return path.join(root, ".cursor", "mcp.json");
    case "gemini":
      return path.join(root, ".gemini", "settings.json");
    case "opencode":
      return scope === "project"
        ? path.join(root, "opencode.json")
        : path.join(xdgConfigHome, "opencode", "opencode.json");
  }
}

async function readForTool(tool: Tool, file: string): Promise<RawMcpEntry[]> {
  switch (tool) {
    case "claude":
      return readClaudeMcps(file);
    case "codex":
      return readCodexMcps(file);
    case "cursor":
      return readCursorMcps(file);
    case "gemini":
      return readGeminiMcps(file);
    case "opencode":
      return readOpenCodeMcps(file);
  }
}

type Candidate = {
  name: string;
  tool: Tool;
  source: string; // file path (for reporting)
  server: Server;
  canonical: string; // normalized canonical JSON
  hash: string;
  warnings: string[];
};

type InvalidCandidate = {
  name: string;
  tool: Tool;
  source: string;
  reason: string;
};

function canonicalize(server: Server): string {
  // Deterministic canonical JSON: sort keys recursively.
  return JSON.stringify(server, Object.keys(server).sort());
}

function hashCanonical(canonical: string): string {
  return createHash("sha256").update(canonical).digest("hex");
}

const SCAN_ORDER: readonly Tool[] = [
  "claude",
  "codex",
  "cursor",
  "gemini",
  "opencode",
];

function pickByScanOrder(cands: Candidate[]): Candidate {
  for (const tool of SCAN_ORDER) {
    const hit = cands.find((c) => c.tool === tool);
    if (hit) return hit;
  }
  return cands[0] as Candidate;
}

function canonicalDestFile(targetRoot: string, name: string): string {
  return path.join(targetRoot, ".agents", "mcps", `${name}.json`);
}

async function readCanonicalIfPresent(
  destFile: string,
): Promise<{ server: Server; canonical: string; hash: string } | null> {
  const text = await readFileOrNull(destFile);
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  // Use ServerSchema indirectly via the same canonicalize/normalize pipeline.
  // For safety, just re-serialize sorted; if it doesn't parse to ServerSchema
  // we treat it as opaque-but-present and let the diff cause skip-existing.
  try {
    // Lazy import to avoid a cyclic concern; ServerSchema is exported.
    const { ServerSchema } = await import("./schema.js");
    const server = ServerSchema.parse(parsed);
    const canonical = canonicalize(server);
    return { server, canonical, hash: hashCanonical(canonical) };
  } catch {
    // Present-but-non-canonical: hash the raw bytes so a diff is still
    // detectable. Conservative: treat as "exists, differs from any source".
    const canonical = text;
    return {
      server: {} as Server,
      canonical,
      hash: hashCanonical(canonical),
    };
  }
}

export async function runMcpImport(
  opts: McpImportOptions,
): Promise<McpImportResult> {
  const targetRoot = opts.scope === "project" ? opts.cwd : homedir();
  const xdg = resolveXdgConfigHome(targetRoot);
  const canonicalDir = path.join(targetRoot, ".agents", "mcps");

  const sources = mcpSourceFilesFor(opts.scope, targetRoot, xdg, opts.from);

  const allCandidates: Candidate[] = [];
  const invalid: InvalidCandidate[] = [];
  const scanned: McpImportResult["scanned"] = [];

  for (const src of sources) {
    let entries: RawMcpEntry[];
    try {
      entries = await readForTool(src.tool, src.file);
    } catch (e) {
      // Parse-level failure (malformed JSON/TOML); record as a single skip-invalid
      invalid.push({
        name: "(file)",
        tool: src.tool,
        source: src.file,
        reason: (e as Error).message,
      });
      scanned.push({ tool: src.tool, file: src.file, found: [] });
      continue;
    }
    const found: string[] = [];
    for (const ent of entries) {
      const r: ReverseResult = normalizeFor(src.tool, ent.raw, ent.name);
      if (r.kind === "reverse-error") {
        invalid.push({
          name: ent.name,
          tool: src.tool,
          source: src.file,
          reason: r.reason,
        });
        continue;
      }
      const canonical = canonicalize(r.server);
      allCandidates.push({
        name: ent.name,
        tool: src.tool,
        source: src.file,
        server: r.server,
        canonical,
        hash: hashCanonical(canonical),
        warnings: r.warnings,
      });
      found.push(ent.name);
    }
    scanned.push({ tool: src.tool, file: src.file, found });
  }

  // Group by name.
  const byName = new Map<string, Candidate[]>();
  for (const c of allCandidates) {
    const list = byName.get(c.name) ?? [];
    list.push(c);
    byName.set(c.name, list);
  }

  // Pre-read existing canonical entries for diff.
  const canonicalExisting = new Map<
    string,
    { canonical: string; hash: string }
  >();
  if (await pathExists(canonicalDir)) {
    const ents = await fs.readdir(canonicalDir);
    for (const f of ents) {
      if (!f.endsWith(".json")) continue;
      const name = f.slice(0, -".json".length);
      const existing = await readCanonicalIfPresent(path.join(canonicalDir, f));
      if (existing) {
        canonicalExisting.set(name, {
          canonical: existing.canonical,
          hash: existing.hash,
        });
      }
    }
  }

  const actions: McpImportAction[] = [];

  // Pull invalid candidates in first so the user sees parse/normalize failures.
  for (const inv of invalid) {
    actions.push({
      kind: "skip-invalid",
      name: inv.name,
      tool: inv.tool,
      source: inv.source,
      reason: inv.reason,
    });
  }

  for (const [name, cands] of byName) {
    const destFile = canonicalDestFile(targetRoot, name);
    const existing = canonicalExisting.get(name);
    const uniqueHashes = new Set(cands.map((c) => c.hash));
    const sourcesTouching = Array.from(new Set(cands.map((c) => c.tool)));

    if (existing !== undefined) {
      if (uniqueHashes.size === 1 && cands[0]!.hash === existing.hash) {
        actions.push({
          kind: "noop-already-canonical",
          name,
          sources: sourcesTouching,
        });
        continue;
      }
      if (opts.force) {
        actions.push({
          kind: "overwrite",
          name,
          sources: sourcesTouching,
          destFile,
        });
      } else {
        actions.push({
          kind: "skip-existing",
          name,
          destFile,
          sources: sourcesTouching,
        });
      }
      continue;
    }

    if (uniqueHashes.size === 1) {
      actions.push({
        kind: "copy",
        name,
        sources: sourcesTouching,
        destFile,
      });
    } else {
      if (opts.force) {
        actions.push({
          kind: "copy",
          name,
          sources: sourcesTouching,
          destFile,
        });
      } else {
        actions.push({
          kind: "skip-conflict",
          name,
          byTool: cands.map((c) => ({
            tool: c.tool,
            source: c.source,
            hash: c.hash,
          })),
        });
      }
    }
  }

  actions.sort((a, b) => a.name.localeCompare(b.name));

  const imported: string[] = [];
  const skipped: string[] = [];

  if (!opts.dryRun) {
    await fs.mkdir(canonicalDir, { recursive: true });
    for (const action of actions) {
      if (action.kind === "copy" || action.kind === "overwrite") {
        const cands = byName.get(action.name) ?? [];
        const pick = pickByScanOrder(cands);
        await fs.writeFile(action.destFile, stringifyJson(pick.server), "utf8");
        imported.push(action.name);
      } else if (
        action.kind === "skip-conflict" ||
        action.kind === "skip-existing" ||
        action.kind === "skip-invalid"
      ) {
        skipped.push(action.name);
      }
    }
  } else {
    for (const action of actions) {
      if (action.kind === "copy" || action.kind === "overwrite") {
        imported.push(action.name);
      } else if (
        action.kind === "skip-conflict" ||
        action.kind === "skip-existing" ||
        action.kind === "skip-invalid"
      ) {
        skipped.push(action.name);
      }
    }
  }

  return { actions, scanned, targetRoot, imported, skipped };
}
