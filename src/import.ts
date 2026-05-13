// `agent-setup import` orchestrator.
//
// Dispatches by --type (skill | mcp | both) to per-type sub-orchestrators,
// then merges their results into one ImportResult for the CLI to render.

import { homedir } from "node:os";

import type { Scope } from "./types.js";
import type { Tool } from "./import-sources.js";
import {
  runSkillImport,
  type SkillImportAction,
  type SkillImportResult,
} from "./import-skills.js";
import {
  runMcpImport,
  type McpImportAction,
  type McpImportResult,
} from "./import-mcps.js";

export type ImportTypeFilter = "skill" | "mcp" | "both";

export type ImportOptions = {
  cwd: string;
  scope: Scope;
  /** Optional --from filter — narrows scan to one harness. */
  from?: Tool;
  /** Default "both". */
  type?: ImportTypeFilter;
  dryRun: boolean;
  force: boolean;
};

export type ImportAction = SkillImportAction | McpImportAction;

export type ImportResult = {
  type: ImportTypeFilter;
  /** Flat, derived list of every action from both sub-orchestrators. */
  actions: ImportAction[];
  /** Per-type sub-results, null when that type wasn't requested. */
  skills: SkillImportResult | null;
  mcps: McpImportResult | null;
  targetRoot: string;
  /** Bare names of newly imported entries (skills + mcps, concatenated). */
  imported: string[];
  /** Bare names of skipped entries. */
  skipped: string[];
};

export async function runImport(opts: ImportOptions): Promise<ImportResult> {
  const type: ImportTypeFilter = opts.type ?? "both";

  const subOpts = {
    cwd: opts.cwd,
    scope: opts.scope,
    from: opts.from,
    dryRun: opts.dryRun,
    force: opts.force,
  };

  let skills: SkillImportResult | null = null;
  let mcps: McpImportResult | null = null;
  if (type === "skill" || type === "both") {
    skills = await runSkillImport(subOpts);
  }
  if (type === "mcp" || type === "both") {
    mcps = await runMcpImport(subOpts);
  }

  const targetRoot =
    skills?.targetRoot ??
    mcps?.targetRoot ??
    (opts.scope === "project" ? opts.cwd : homedir());

  const actions: ImportAction[] = [];
  const imported: string[] = [];
  const skipped: string[] = [];
  if (skills) {
    actions.push(...skills.actions);
    imported.push(...skills.imported);
    skipped.push(...skills.skipped);
  }
  if (mcps) {
    actions.push(...mcps.actions);
    imported.push(...mcps.imported);
    skipped.push(...mcps.skipped);
  }

  return { type, actions, skills, mcps, targetRoot, imported, skipped };
}

export function formatImportSummary(r: ImportResult, dryRun: boolean): string {
  const lines: string[] = [];
  lines.push(
    dryRun
      ? "agent-setup import: Dry run — no files will be written"
      : "agent-setup import:",
  );

  if (r.skills) {
    for (const s of r.skills.scanned) {
      const found = s.found.length === 0 ? "(empty)" : s.found.join(", ");
      lines.push(`  scan ${s.tool} skills: ${s.dir} → ${found}`);
    }
  }
  if (r.mcps) {
    for (const s of r.mcps.scanned) {
      const found = s.found.length === 0 ? "(empty)" : s.found.join(", ");
      lines.push(`  scan ${s.tool} mcps: ${s.file} → ${found}`);
    }
  }

  if (r.skills) {
    for (const a of r.skills.actions) lines.push(formatSkillAction(a, dryRun));
  }
  if (r.mcps) {
    for (const a of r.mcps.actions) lines.push(formatMcpAction(a, dryRun));
  }

  const importedN = r.imported.length;
  const skippedN = r.skipped.length;
  const total = importedN + skippedN;
  if (total === 0) {
    lines.push(`  nothing to import.`);
  } else {
    const verb = dryRun ? "would import" : "imported";
    lines.push(
      `  ${verb} ${importedN} of ${total} entr${total === 1 ? "y" : "ies"} into .agents/${skippedN > 0 ? `, ${skippedN} skipped` : ""}.`,
    );
    if (importedN > 0 && !dryRun) {
      lines.push("  run `agent-setup install` to propagate to other tools.");
    }
  }
  return lines.join("\n") + "\n";
}

function formatSkillAction(a: SkillImportAction, dryRun: boolean): string {
  if (a.kind === "copy") {
    const verb = dryRun ? "would import" : "import";
    return `  ✓ skill ${a.name} → ${verb} from ${a.sources.join(", ")}`;
  }
  if (a.kind === "overwrite") {
    const verb = dryRun ? "would overwrite" : "overwrite";
    return `  ✓ skill ${a.name} → ${verb} (--force) from ${a.sources.join(", ")}`;
  }
  if (a.kind === "noop-already-canonical") {
    return `  · skill ${a.name} already in .agents/ (matches ${a.sources.join(", ")})`;
  }
  if (a.kind === "skip-existing") {
    return `  ✗ skill ${a.name} exists in .agents/skills/ and differs from ${a.sources.join(", ")}; pass --force to overwrite`;
  }
  if (a.kind === "skip-conflict") {
    const tools = a.byTool.map((b) => b.tool).join(", ");
    return `  ✗ skill ${a.name} differs between ${tools}\n    re-run with: agent-setup import --from <tool>`;
  }
  return `  ! skill ${a.name} (${a.tool}) skipped: ${a.reason}`;
}

function formatMcpAction(a: McpImportAction, dryRun: boolean): string {
  if (a.kind === "copy") {
    const verb = dryRun ? "would import" : "import";
    return `  ✓ mcp ${a.name} → ${verb} from ${a.sources.join(", ")}`;
  }
  if (a.kind === "overwrite") {
    const verb = dryRun ? "would overwrite" : "overwrite";
    return `  ✓ mcp ${a.name} → ${verb} (--force) from ${a.sources.join(", ")}`;
  }
  if (a.kind === "noop-already-canonical") {
    return `  · mcp ${a.name} already in .agents/ (matches ${a.sources.join(", ")})`;
  }
  if (a.kind === "skip-existing") {
    return `  ✗ mcp ${a.name} exists in .agents/mcps/ and differs from ${a.sources.join(", ")}; pass --force to overwrite`;
  }
  if (a.kind === "skip-conflict") {
    const tools = a.byTool.map((b) => b.tool).join(", ");
    return `  ✗ mcp ${a.name} differs between ${tools}\n    re-run with: agent-setup import --from <tool>`;
  }
  return `  ! mcp ${a.name} (${a.tool}) skipped: ${a.reason}`;
}
