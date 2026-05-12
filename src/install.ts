// Orchestrator for `agent-setup install`.
//
// Pipeline:
//   1. Resolve source root from --repo (local paths only in this chunk).
//   2. discoverSource → { canonical, sourcePath }
//   3. Determine target root (cwd for project, $HOME for global).
//   4. For each emitter that's installed (intersected with --tool):
//        a. Filter canonical by --type (skill | mcp | both).
//        b. Filter servers by `targets` whitelist if set.
//        c. Call emit(input) and tag with { emitter }.
//   5. Read prevLockfile, reconcile, write newLockfile.
//   6. Print a human-readable summary, including OAuth login hints.

import { homedir } from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import { discoverSource, NoSourceFoundError } from "./load-source.js";
import {
  resolveRepoRef,
  materializeRepo,
  type MaterializeResult,
} from "./repo.js";
import { claudeEmitter } from "./emitters/claude.js";
import { codexEmitter } from "./emitters/codex.js";
import { cursorEmitter } from "./emitters/cursor.js";
import { geminiEmitter } from "./emitters/gemini.js";
import { opencodeEmitter } from "./emitters/opencode.js";
import {
  reconcile,
  type ReconcileResult,
  type TaggedChange,
} from "./reconcile.js";
import {
  readLockfile,
  writeLockfile,
} from "./lockfile.js";
import type { Canonical, Server } from "./schema.js";
import type { Emitter, EmitInput, Scope } from "./types.js";

export const ALL_EMITTERS: Emitter[] = [
  claudeEmitter,
  codexEmitter,
  cursorEmitter,
  geminiEmitter,
  opencodeEmitter,
];

export type TypeFilter = "skill" | "mcp" | "both";

export type InstallOptions = {
  repo: string; // local path; "." or absolute/relative
  scope: Scope;
  tool: string[] | null; // null = all detected
  type: TypeFilter;
  dryRun: boolean;
  force: boolean;
  cwd: string; // typically process.cwd()
  generator?: string;
  // Optional override for canonical (used by uninstall --all path
  // when we want to reconcile against an empty desire-set without
  // re-reading the source). When set, we skip discoverSource.
  canonicalOverride?: Canonical;
};

export type InstallResult = {
  reconcile: ReconcileResult;
  emittersUsed: string[];
  emittersDetected: string[];
  oauthHints: Array<{ emitter: string; server: string; hint: string }>;
  sourcePath: string | null;
  targetRoot: string;
  materialize: MaterializeResult | null;
};

const OAUTH_HINTS: Record<string, (name: string) => string> = {
  claude: () => "/mcp inside Claude Code",
  codex: (n) => `codex mcp login ${n}`,
  gemini: (n) => `/mcp auth ${n} inside Gemini CLI`,
  opencode: (n) => `opencode mcp auth ${n}`,
  cursor: () => "(auto on first server use)",
};

function filterByType(canonical: Canonical, t: TypeFilter): Canonical {
  if (t === "both") return canonical;
  if (t === "skill") {
    return { ...canonical, servers: [] };
  }
  // t === "mcp"
  return { ...canonical, skills: [] };
}

function filterServersByTarget(servers: Server[], emitterName: string): Server[] {
  return servers.filter((s) => {
    if (!s.targets || s.targets.length === 0) return true;
    return s.targets.includes(emitterName);
  });
}

function pickEmitters(
  allowed: string[] | null,
): Emitter[] {
  if (allowed === null) return ALL_EMITTERS;
  const set = new Set(allowed.map((s) => s.trim()).filter((s) => s.length > 0));
  return ALL_EMITTERS.filter((e) => set.has(e.name));
}

async function detectInstalled(
  emitter: Emitter,
  root: string,
  scope: Scope,
): Promise<boolean> {
  if (!emitter.detect) return true;
  const r = await emitter.detect({ root, scope });
  return r.installed;
}

export async function runInstall(opts: InstallOptions): Promise<InstallResult> {
  const generator = opts.generator ?? "agent-setup@0.1.0-alpha.0";

  // Resolve --repo (may trigger a remote shallow-clone + materialize step).
  // For remote refs we materialize into <projectRoot>/.agents and then
  // discoverSource against the project root. For local refs we behave
  // exactly as before: resolve relative to cwd, hand off to discoverSource.
  let materialize: MaterializeResult | null = null;
  let sourceRoot: string;
  if (opts.canonicalOverride) {
    // Override path doesn't read source; pick something sensible.
    sourceRoot = path.resolve(opts.cwd, opts.repo);
  } else {
    const ref = resolveRepoRef(opts.repo);
    if (ref.kind === "local") {
      sourceRoot = path.resolve(opts.cwd, ref.path);
    } else {
      // Remote: materialize into the project root's .agents/ directory.
      // Project root = opts.cwd (that's where we'll then read from).
      const destAgentsDir = path.join(opts.cwd, ".agents");
      materialize = await materializeRepo({
        ref,
        destAgentsDir,
        force: opts.force,
        dryRun: opts.dryRun,
      });
      // After materialization, source-of-truth is the local project root.
      sourceRoot = opts.cwd;
      // On dry-run, nothing was written into .agents; if no .agents exists
      // yet, discoverSource will throw — handled below as "empty source".
    }
  }

  let canonical: Canonical;
  let sourcePath: string | null;
  if (opts.canonicalOverride) {
    canonical = opts.canonicalOverride;
    sourcePath = null;
  } else {
    try {
      const ds = await discoverSource(sourceRoot);
      canonical = ds.canonical;
      sourcePath = ds.sourcePath;
    } catch (e) {
      // Only swallow "no source found at all" — schema/parse errors and
      // anything else should bubble up so the user sees the real problem.
      if (e instanceof NoSourceFoundError) {
        canonical = { skills: [], servers: [], agentsMd: null };
        sourcePath = null;
      } else {
        throw e;
      }
    }
  }

  // Apply --type filter.
  canonical = filterByType(canonical, opts.type);

  // Target root depends on scope.
  const targetRoot = opts.scope === "project" ? opts.cwd : homedir();

  // Choose emitters: --tool allowlist intersected with detected.
  const requested = pickEmitters(opts.tool);
  const emittersUsed: Emitter[] = [];
  const emittersDetected: string[] = [];
  for (const e of requested) {
    const installed = await detectInstalled(e, targetRoot, opts.scope);
    if (installed) {
      emittersUsed.push(e);
      emittersDetected.push(e.name);
    }
  }

  // Build tagged changes.
  const changes: TaggedChange[] = [];
  const oauthHints: Array<{ emitter: string; server: string; hint: string }> = [];
  for (const emitter of emittersUsed) {
    const serversForEmitter = filterServersByTarget(
      canonical.servers,
      emitter.name,
    );
    const input: EmitInput = {
      servers: serversForEmitter,
      skills: canonical.skills,
      agentsMd: canonical.agentsMd,
      scope: opts.scope,
      root: targetRoot,
    };
    const out = emitter.emit(input);
    for (const ch of out) {
      changes.push({ ...ch, emitter: emitter.name });
    }
    // Collect OAuth hints for any oauth servers we emitted.
    for (const srv of serversForEmitter) {
      if (srv.auth === "oauth") {
        const fn = OAUTH_HINTS[emitter.name];
        if (fn) {
          oauthHints.push({
            emitter: emitter.name,
            server: srv.name,
            hint: fn(srv.name),
          });
        }
      }
    }
  }

  // Read prev lockfile, reconcile.
  const prevLockfile = await readLockfile(opts.scope, targetRoot, generator);
  const result = await reconcile({
    changes,
    prevLockfile,
    scope: opts.scope,
    root: targetRoot,
    generator,
    force: opts.force,
    dryRun: opts.dryRun,
  });

  // Persist lockfile (skip on dry-run).
  if (!opts.dryRun) {
    // Make sure the target .agents dir exists for project scope so
    // writeLockfile can drop the lock file. (Global scope creates
    // ~/.agents/ on demand.)
    const dir = path.dirname(
      opts.scope === "project"
        ? path.join(targetRoot, ".agents", ".lock.json")
        : path.join(homedir(), ".agents", ".lock.json"),
    );
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch {
      // ignore
    }
    await writeLockfile(opts.scope, targetRoot, result.newLockfile);
  }

  return {
    reconcile: result,
    emittersUsed: emittersUsed.map((e) => e.name),
    emittersDetected,
    oauthHints,
    sourcePath,
    targetRoot,
    materialize,
  };
}

// Render a short, human-readable summary suitable for stdout.
export function formatInstallSummary(r: InstallResult, dryRun: boolean): string {
  const lines: string[] = [];
  lines.push(
    dryRun
      ? "agent-setup: Dry run — no files will be written"
      : "agent-setup: install complete",
  );
  if (r.materialize) {
    const m = r.materialize;
    const verb = dryRun ? "would copy" : "copied";
    lines.push(
      `  materialize: ${verb} ${m.copiedSkills.length} skill(s), ${m.copiedMcps.length} mcp(s)` +
        (m.skipped.length > 0 ? `, ${m.skipped.length} skipped` : ""),
    );
    if (m.copiedSkills.length > 0) {
      lines.push(`    skills: ${m.copiedSkills.join(", ")}`);
    }
    if (m.copiedMcps.length > 0) {
      lines.push(`    mcps: ${m.copiedMcps.join(", ")}`);
    }
    for (const s of m.skipped) {
      lines.push(`    skipped ${s.kind}/${s.name}: ${s.reason}`);
    }
  }
  lines.push(
    `  detected: ${r.emittersDetected.length > 0 ? r.emittersDetected.join(", ") : "(none)"}`,
  );
  // Per-emitter applied counts.
  const counts = new Map<string, { writes: number; sweeps: number; noops: number }>();
  for (const a of r.reconcile.applied) {
    const e = a.emitter;
    const cur = counts.get(e) ?? { writes: 0, sweeps: 0, noops: 0 };
    if (a.kind.endsWith("-sweep")) {
      cur.sweeps++;
    } else if ("noop" in a && a.noop) {
      cur.noops++;
    } else {
      cur.writes++;
    }
    counts.set(e, cur);
  }
  const verbWrite = dryRun ? "would-write" : "write";
  const verbSweep = dryRun ? "would-sweep" : "sweep";
  for (const [e, c] of counts) {
    lines.push(
      `  ${e}: ${c.writes} ${verbWrite}(s), ${c.sweeps} ${verbSweep}(s), ${c.noops} no-op(s)`,
    );
  }
  // Lockfile-diff summary: how many entries we now own.
  const owns = r.reconcile.newLockfile.owns;
  const skillCount = Object.keys(owns.skills).length;
  const mcpCount = Object.keys(owns.mcps).length;
  const fileCount = Object.keys(owns.files).length;
  lines.push(
    `  lockfile: ${skillCount} skill(s), ${mcpCount} mcp(s), ${fileCount} file-entr(ies)`,
  );
  if (r.reconcile.refusals.length > 0) {
    lines.push(`  refusals: ${r.reconcile.refusals.length}`);
    for (const ref of r.reconcile.refusals) {
      if (ref.kind === "marker-missing") {
        lines.push(
          `    - ${ref.emitter}: refused to overwrite ${ref.path} (no marker; pass --force to override)`,
        );
      } else if (ref.kind === "real-dir-conflict") {
        lines.push(`    - ${ref.emitter}: real directory at ${ref.link} (left untouched)`);
      } else {
        lines.push(`    - ${ref.emitter}: real file at ${ref.link} (left untouched)`);
      }
    }
  }
  if (r.oauthHints.length > 0) {
    lines.push("  oauth login next steps:");
    // Group by emitter for readability.
    const byEmitter = new Map<string, Array<{ server: string; hint: string }>>();
    for (const h of r.oauthHints) {
      const list = byEmitter.get(h.emitter) ?? [];
      list.push({ server: h.server, hint: h.hint });
      byEmitter.set(h.emitter, list);
    }
    for (const [emitter, items] of byEmitter) {
      // All hints from the same emitter share the same login command shape;
      // print the emitter once with its servers + the hint per server.
      for (const it of items) {
        lines.push(`    - ${emitter} / ${it.server}: ${it.hint}`);
      }
    }
  }
  return lines.join("\n") + "\n";
}
