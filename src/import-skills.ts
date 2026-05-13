// Skill-only half of `agent-setup import`.
//
// Scans per-harness skill directories (.claude/skills/, .cursor/skills/, …)
// and copies SKILL.md skills into the canonical `.agents/skills/` for the
// current scope. Does not write to per-tool configs — `install` does that.

import { homedir } from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import { hashDir } from "./hash-dir.js";
import { loadSkillFromDir } from "./load-source.js";
import {
  sourcePathsFor,
  type SourceDir,
  type Tool,
} from "./import-sources.js";
import { resolveXdgConfigHome, pathExists, readDirSafe } from "./import-fs.js";
import type { Scope } from "./types.js";

export type SkillImportOptions = {
  cwd: string;
  scope: Scope;
  /** Optional --from filter. */
  from?: Tool;
  dryRun: boolean;
  force: boolean;
};

export type SkillImportAction =
  | {
      kind: "copy";
      name: string;
      sourceDir: string;
      sources: Tool[];
      destDir: string;
    }
  | {
      kind: "noop-already-canonical";
      name: string;
      sources: Tool[];
    }
  | {
      kind: "skip-conflict";
      name: string;
      byTool: Array<{ tool: Tool; sourceDir: string; hash: string }>;
    }
  | {
      kind: "skip-existing";
      name: string;
      destDir: string;
      sources: Tool[];
    }
  | {
      kind: "overwrite";
      name: string;
      sourceDir: string;
      sources: Tool[];
      destDir: string;
    }
  | {
      kind: "skip-invalid";
      name: string;
      sourceDir: string;
      tool: Tool;
      reason: string;
    };

export type SkillImportResult = {
  actions: SkillImportAction[];
  scanned: Array<{ tool: Tool; dir: string; found: string[] }>;
  targetRoot: string;
  imported: string[];
  skipped: string[];
};

type Candidate = {
  name: string;
  tool: Tool;
  sourceDir: string;
  hash: string;
};

type InvalidCandidate = {
  name: string;
  tool: Tool;
  sourceDir: string;
  reason: string;
};

async function scanSource(
  src: SourceDir,
  canonicalSkillsDir: string,
): Promise<{ candidates: Candidate[]; invalid: InvalidCandidate[]; found: string[] }> {
  const candidates: Candidate[] = [];
  const invalid: InvalidCandidate[] = [];
  const found: string[] = [];

  const entries = await readDirSafe(src.dir);
  for (const entry of entries) {
    const full = path.join(src.dir, entry);
    let st: import("node:fs").Stats;
    try {
      st = await fs.lstat(full);
    } catch {
      continue;
    }
    // Resolve symlinks to detect "this points back into .agents/skills/<entry>"
    if (st.isSymbolicLink()) {
      try {
        const real = await fs.realpath(full);
        const canonicalSelf = await fs.realpath(
          path.join(canonicalSkillsDir, entry),
        );
        if (real === canonicalSelf) continue;
      } catch {
        // Dangling symlink, or canonical-self doesn't exist — fall through
        // to normal loading (hash compare downstream catches "already canonical").
      }
    }
    let resolved: import("node:fs").Stats;
    try {
      resolved = await fs.stat(full);
    } catch {
      continue;
    }
    if (!resolved.isDirectory()) continue;

    let skill;
    try {
      skill = await loadSkillFromDir(full);
    } catch (e) {
      invalid.push({
        name: entry,
        tool: src.tool,
        sourceDir: full,
        reason: (e as Error).message,
      });
      continue;
    }
    if (skill === null) continue;
    if (skill.name !== entry) {
      invalid.push({
        name: entry,
        tool: src.tool,
        sourceDir: full,
        reason: `name="${skill.name}" but lives in dir "${entry}"`,
      });
      continue;
    }
    const hash = await hashDir(full);
    candidates.push({ name: skill.name, tool: src.tool, sourceDir: full, hash });
    found.push(skill.name);
  }
  return { candidates, invalid, found };
}

const SCAN_ORDER: readonly Tool[] = ["claude", "codex", "cursor", "gemini", "opencode"];

function pickByScanOrder(candidates: Candidate[]): Candidate {
  for (const tool of SCAN_ORDER) {
    const hit = candidates.find((c) => c.tool === tool);
    if (hit) return hit;
  }
  return candidates[0] as Candidate;
}

export async function runSkillImport(
  opts: SkillImportOptions,
): Promise<SkillImportResult> {
  const targetRoot = opts.scope === "project" ? opts.cwd : homedir();
  const xdg = resolveXdgConfigHome(targetRoot);
  const canonicalSkillsDir = path.join(targetRoot, ".agents", "skills");

  const sources = sourcePathsFor(opts.scope, targetRoot, xdg, opts.from);

  const allCandidates: Candidate[] = [];
  const invalid: InvalidCandidate[] = [];
  const scanned: SkillImportResult["scanned"] = [];
  for (const src of sources) {
    const r = await scanSource(src, canonicalSkillsDir);
    allCandidates.push(...r.candidates);
    invalid.push(...r.invalid);
    scanned.push({ tool: src.tool, dir: src.dir, found: r.found });
  }

  const byName = new Map<string, Candidate[]>();
  for (const c of allCandidates) {
    const list = byName.get(c.name) ?? [];
    list.push(c);
    byName.set(c.name, list);
  }

  const canonicalHashes = new Map<string, string>();
  const canonicalEntries = await readDirSafe(canonicalSkillsDir);
  for (const entry of canonicalEntries) {
    const full = path.join(canonicalSkillsDir, entry);
    let st: import("node:fs").Stats;
    try {
      st = await fs.stat(full);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    if (!(await pathExists(path.join(full, "SKILL.md")))) continue;
    canonicalHashes.set(entry, await hashDir(full));
  }

  const actions: SkillImportAction[] = [];

  for (const inv of invalid) {
    actions.push({
      kind: "skip-invalid",
      name: inv.name,
      sourceDir: inv.sourceDir,
      tool: inv.tool,
      reason: inv.reason,
    });
  }

  for (const [name, cands] of byName) {
    const existingHash = canonicalHashes.get(name);
    const destDir = path.join(canonicalSkillsDir, name);

    const uniqueHashes = new Set(cands.map((c) => c.hash));
    const sourcesTouching = Array.from(new Set(cands.map((c) => c.tool)));

    if (existingHash !== undefined) {
      if (uniqueHashes.size === 1 && cands[0]!.hash === existingHash) {
        actions.push({ kind: "noop-already-canonical", name, sources: sourcesTouching });
        continue;
      }
      if (opts.force) {
        const pick = pickByScanOrder(cands);
        actions.push({
          kind: "overwrite",
          name,
          sourceDir: pick.sourceDir,
          sources: sourcesTouching,
          destDir,
        });
      } else {
        actions.push({ kind: "skip-existing", name, destDir, sources: sourcesTouching });
      }
      continue;
    }

    if (uniqueHashes.size === 1) {
      const pick = pickByScanOrder(cands);
      actions.push({
        kind: "copy",
        name,
        sourceDir: pick.sourceDir,
        sources: sourcesTouching,
        destDir,
      });
    } else {
      if (opts.force) {
        const pick = pickByScanOrder(cands);
        actions.push({
          kind: "copy",
          name,
          sourceDir: pick.sourceDir,
          sources: sourcesTouching,
          destDir,
        });
      } else {
        actions.push({
          kind: "skip-conflict",
          name,
          byTool: cands.map((c) => ({
            tool: c.tool,
            sourceDir: c.sourceDir,
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
    await fs.mkdir(canonicalSkillsDir, { recursive: true });
    for (const action of actions) {
      if (action.kind === "copy") {
        await fs.cp(action.sourceDir, action.destDir, {
          recursive: true,
          dereference: true,
        });
        imported.push(action.name);
      } else if (action.kind === "overwrite") {
        await fs.rm(action.destDir, { recursive: true, force: true });
        await fs.cp(action.sourceDir, action.destDir, {
          recursive: true,
          dereference: true,
        });
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
