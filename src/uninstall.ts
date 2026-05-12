// `agent-setup uninstall` orchestrator.
//
// Two modes:
//   - <name>:  delete .agents/skills/<name>/ and/or .agents/mcps/<name>.json
//              from the source root, then run the install pipeline so the
//              orphan-sweep removes per-tool entries.
//   - --all:   leave .agents/ alone; reconcile against an EMPTY canonical
//              so the orphan-sweep removes everything we own. Lockfile
//              becomes empty.

import path from "node:path";
import { promises as fs } from "node:fs";

import { runInstall, type InstallResult, type TypeFilter } from "./install.js";
import type { Scope } from "./types.js";

export type UninstallOptions = {
  name: string | null; // null with all=true; non-null otherwise
  all: boolean;
  scope: Scope;
  tool: string[] | null;
  type: TypeFilter;
  dryRun: boolean;
  force: boolean;
  cwd: string;
  repo: string; // local path; default "."
  generator?: string;
};

export type UninstallResult = InstallResult & {
  removedFromSource: string[]; // paths we deleted in .agents/ (none for --all)
};

async function rmIfExists(p: string): Promise<boolean> {
  try {
    await fs.rm(p, { recursive: true, force: false });
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return false;
    // For files, fs.rm without recursive on a missing path also throws
    // ENOENT — handled above. Anything else is a real error.
    throw e;
  }
}

export async function runUninstall(
  opts: UninstallOptions,
): Promise<UninstallResult> {
  if (opts.all) {
    // No source mutation. Reconcile with an empty canonical so the
    // orphan-sweep removes everything we own.
    const r = await runInstall({
      repo: opts.repo,
      scope: opts.scope,
      tool: opts.tool,
      type: "both",
      dryRun: opts.dryRun,
      force: opts.force,
      cwd: opts.cwd,
      ...(opts.generator !== undefined ? { generator: opts.generator } : {}),
      canonicalOverride: { skills: [], servers: [], agentsMd: null },
    });
    return { ...r, removedFromSource: [] };
  }

  if (!opts.name) {
    throw new Error("uninstall requires either a <name> or --all");
  }

  // Targeted removal from source. We delete from the resolved source root
  // (--repo, default "."). Note: deleting from the source means the next
  // install pass naturally sweeps per-tool entries.
  const sourceRoot = path.resolve(opts.cwd, opts.repo);
  const removedFromSource: string[] = [];

  // Decide which type(s) to delete.
  const wantSkill = opts.type === "both" || opts.type === "skill";
  const wantMcp = opts.type === "both" || opts.type === "mcp";

  if (!opts.dryRun) {
    if (wantSkill) {
      const skillDir = path.join(
        sourceRoot,
        ".agents",
        "skills",
        opts.name,
      );
      if (await rmIfExists(skillDir)) {
        removedFromSource.push(skillDir);
      }
    }
    if (wantMcp) {
      const mcpFile = path.join(
        sourceRoot,
        ".agents",
        "mcps",
        `${opts.name}.json`,
      );
      if (await rmIfExists(mcpFile)) {
        removedFromSource.push(mcpFile);
      }
    }
  } else {
    // Dry run: just probe.
    if (wantSkill) {
      const skillDir = path.join(
        sourceRoot,
        ".agents",
        "skills",
        opts.name,
      );
      try {
        await fs.stat(skillDir);
        removedFromSource.push(skillDir);
      } catch {
        // missing
      }
    }
    if (wantMcp) {
      const mcpFile = path.join(
        sourceRoot,
        ".agents",
        "mcps",
        `${opts.name}.json`,
      );
      try {
        await fs.stat(mcpFile);
        removedFromSource.push(mcpFile);
      } catch {
        // missing
      }
    }
  }

  // Now run the install pipeline so orphan-sweep does its job. We pass
  // the same --type filter through; if the user asked to uninstall only
  // a skill, we want install to still treat servers as authoritative
  // (they remain in .agents/), so passing "both" is right here. The
  // type-narrowing already happened at the source-deletion step.
  const r = await runInstall({
    repo: opts.repo,
    scope: opts.scope,
    tool: opts.tool,
    type: "both",
    dryRun: opts.dryRun,
    force: opts.force,
    cwd: opts.cwd,
    ...(opts.generator !== undefined ? { generator: opts.generator } : {}),
  });

  return { ...r, removedFromSource };
}
