// Orchestrator for `agent-setup import` (skills only in v0.1).
//
// Scans configured per-harness skill directories and copies skills it finds
// into the canonical `.agents/skills/` for the current scope. Does not write
// to per-tool configs — that's `install`'s job, run separately after.
//
// Pipeline:
//   1. Resolve scope root (cwd for project, $HOME for global).
//   2. Build source list via sourcePathsFor(scope, root, xdg, fromFilter).
//   3. Walk each source dir, loading SKILL.md files via loadSkillFromDir.
//      Skip dirs whose `SKILL.md` parent resolves into `<root>/.agents/skills/`
//      (self-symlink — we likely put it there during a previous install).
//   4. Hash each candidate skill directory.
//   5. Group by skill name; apply decision logic (see plan).
//   6. If dry-run: return plan without writes.
//   7. Otherwise: copy each "copy" action into `<root>/.agents/skills/<name>/`.

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
import type { Scope } from "./types.js";

export type ImportOptions = {
  cwd: string;
  scope: Scope;
  /** Optional --from filter. */
  from?: Tool;
  dryRun: boolean;
  force: boolean;
};

export type ImportAction =
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

export type ImportResult = {
  actions: ImportAction[];
  scanned: Array<{ tool: Tool; dir: string; found: string[] }>;
  targetRoot: string;
  imported: string[];
  skipped: string[];
};

function resolveXdgConfigHome(root: string): string {
  const xdg = process.env["XDG_CONFIG_HOME"];
  return xdg && xdg.length > 0 ? xdg : path.join(root, ".config");
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function readDirSafe(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw e;
  }
}

type Candidate = {
  name: string;
  tool: Tool;
  sourceDir: string; // absolute path to the skill dir
  hash: string;
};

type InvalidCandidate = {
  name: string; // dir basename
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
        // realpath both sides — on macOS /var/folders/... resolves to
        // /private/var/folders/... and the raw join would never match.
        const canonicalSelf = await fs.realpath(
          path.join(canonicalSkillsDir, entry),
        );
        if (real === canonicalSelf) {
          // Self-symlink we put here on a prior install — skip silently.
          continue;
        }
      } catch {
        // Dangling symlink, or canonical-self doesn't exist — fall through
        // to normal loading (the hash compare downstream will catch the
        // "already canonical" case).
      }
    }
    // Re-stat following symlinks for type check.
    let resolved: import("node:fs").Stats;
    try {
      resolved = await fs.stat(full);
    } catch {
      continue;
    }
    if (!resolved.isDirectory()) continue;

    // Try to load SKILL.md.
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
    if (skill === null) continue; // No SKILL.md.
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
  // Should never reach (candidates is non-empty); fall back to first.
  return candidates[0] as Candidate;
}

export async function runImport(opts: ImportOptions): Promise<ImportResult> {
  const targetRoot = opts.scope === "project" ? opts.cwd : homedir();
  const xdg = resolveXdgConfigHome(targetRoot);
  const canonicalSkillsDir = path.join(targetRoot, ".agents", "skills");

  const sources = sourcePathsFor(opts.scope, targetRoot, xdg, opts.from);

  const allCandidates: Candidate[] = [];
  const invalid: InvalidCandidate[] = [];
  const scanned: ImportResult["scanned"] = [];
  for (const src of sources) {
    const r = await scanSource(src, canonicalSkillsDir);
    allCandidates.push(...r.candidates);
    invalid.push(...r.invalid);
    scanned.push({ tool: src.tool, dir: src.dir, found: r.found });
  }

  // Group candidates by skill name.
  const byName = new Map<string, Candidate[]>();
  for (const c of allCandidates) {
    const list = byName.get(c.name) ?? [];
    list.push(c);
    byName.set(c.name, list);
  }

  // Hash existing canonical skills (if any).
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

  const actions: ImportAction[] = [];

  // Invalid-frontmatter skills (skip with warning, not fatal).
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

    // Determine cross-source content uniformity.
    const uniqueHashes = new Set(cands.map((c) => c.hash));
    const sourcesTouching = Array.from(new Set(cands.map((c) => c.tool)));

    if (existingHash !== undefined) {
      // Skill is already in .agents/.
      if (uniqueHashes.size === 1 && cands[0]!.hash === existingHash) {
        // Sources match canonical exactly — silent no-op.
        actions.push({
          kind: "noop-already-canonical",
          name,
          sources: sourcesTouching,
        });
        continue;
      }
      if (opts.force) {
        // Pick a source: if --from set, scan returned one tool only; otherwise
        // scan order resolves ties.
        const pick = pickByScanOrder(cands);
        actions.push({
          kind: "overwrite",
          name,
          sourceDir: pick.sourceDir,
          sources: sourcesTouching,
          destDir,
        });
      } else {
        actions.push({
          kind: "skip-existing",
          name,
          destDir,
          sources: sourcesTouching,
        });
      }
      continue;
    }

    // Skill not yet in .agents/.
    if (uniqueHashes.size === 1) {
      // All sources agree (or only one source).
      const pick = pickByScanOrder(cands);
      actions.push({
        kind: "copy",
        name,
        sourceDir: pick.sourceDir,
        sources: sourcesTouching,
        destDir,
      });
    } else {
      // Conflict across sources.
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

  // Stable order in output.
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
      // noop-already-canonical is silent.
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

  return {
    actions,
    scanned,
    targetRoot,
    imported,
    skipped,
  };
}

export function formatImportSummary(r: ImportResult, dryRun: boolean): string {
  const lines: string[] = [];
  lines.push(
    dryRun ? "agent-setup import: Dry run — no files will be written" : "agent-setup import:",
  );
  // Scanned summary.
  for (const s of r.scanned) {
    const found = s.found.length === 0 ? "(empty)" : s.found.join(", ");
    lines.push(`  scan ${s.tool}: ${s.dir} → ${found}`);
  }
  // Per-action lines.
  for (const a of r.actions) {
    if (a.kind === "copy") {
      const verb = dryRun ? "would import" : "import";
      lines.push(`  ✓ ${a.name} → ${verb} from ${a.sources.join(", ")}`);
    } else if (a.kind === "overwrite") {
      const verb = dryRun ? "would overwrite" : "overwrite";
      lines.push(`  ✓ ${a.name} → ${verb} (--force) from ${a.sources.join(", ")}`);
    } else if (a.kind === "noop-already-canonical") {
      lines.push(`  · ${a.name} already in .agents/ (matches ${a.sources.join(", ")})`);
    } else if (a.kind === "skip-existing") {
      lines.push(
        `  ✗ ${a.name} exists in .agents/skills/ and differs from ${a.sources.join(", ")}; pass --force to overwrite`,
      );
    } else if (a.kind === "skip-conflict") {
      const tools = a.byTool.map((b) => b.tool).join(", ");
      lines.push(`  ✗ ${a.name} differs between ${tools}`);
      lines.push(`    re-run with: agent-setup import --from <tool>`);
    } else if (a.kind === "skip-invalid") {
      lines.push(`  ! ${a.name} (${a.tool}) skipped: ${a.reason}`);
    }
  }
  const importedN = r.imported.length;
  const skippedN = r.skipped.length;
  const total = importedN + skippedN;
  if (total === 0) {
    lines.push("  no skills found.");
  } else {
    const verb = dryRun ? "would import" : "imported";
    lines.push(
      `  ${verb} ${importedN} of ${total} skill(s) into .agents/skills/${skippedN > 0 ? `, ${skippedN} skipped` : ""}.`,
    );
    if (importedN > 0 && !dryRun) {
      lines.push("  run `agent-setup install` to propagate to other tools.");
    }
  }
  return lines.join("\n") + "\n";
}
