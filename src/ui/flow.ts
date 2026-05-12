// Interactive install flow orchestrator.
//
// Walks the user through the 10-step interactive flow described in the
// README. We do source discovery and agent detection up front so the
// prompts can be pre-populated, then call into runInstall with a filtered
// canonical (via `canonicalOverride`) to perform the actual writes.
//
// On any cancel we return { cancelled: true, exitCode: 130 } and let the
// CLI surface the exit code; we never call process.exit ourselves.

import { homedir } from "node:os";
import path from "node:path";

import { intro, log, note, outro, spinner } from "@clack/prompts";

import { discoverSource, NoSourceFoundError } from "../load-source.js";
import {
  ALL_EMITTERS,
  runInstall,
  type InstallOptions,
  type InstallResult,
  type TypeFilter,
} from "../install.js";
import {
  resolveRepoRef,
  materializeRepo,
  type MaterializeResult,
} from "../repo.js";
import * as prompts from "./prompts.js";
import type { Canonical, Server, Skill } from "../schema.js";
import type { Emitter, Scope } from "../types.js";

export type InteractiveOptions = {
  repo: string;
  cwd: string;
  type: TypeFilter;
  // If null we prompt for scope; if set we skip the scope prompt.
  scope: Scope | null;
  // If null we prompt for agents; if set we skip the agent prompt.
  tool: string[] | null;
  dryRun: boolean;
  force: boolean;
  generator?: string;
};

export type InteractiveResult = {
  cancelled: boolean;
  result?: InstallResult;
  exitCode: number;
};

// Detect installed emitters at the given root + scope.
async function detectEmitters(
  emitters: Emitter[],
  root: string,
  scope: Scope,
): Promise<Map<string, boolean>> {
  const out = new Map<string, boolean>();
  for (const e of emitters) {
    if (!e.detect) {
      out.set(e.name, true);
      continue;
    }
    const r = await e.detect({ root, scope });
    out.set(e.name, r.installed);
  }
  return out;
}

// Filter the canonical by selected skill/mcp names.
function filterCanonical(
  canonical: Canonical,
  selectedSkills: string[],
  selectedMcps: string[],
  type: TypeFilter,
): Canonical {
  let skills: Skill[] = canonical.skills;
  let servers: Server[] = canonical.servers;
  if (type === "mcp") {
    skills = [];
  } else {
    const set = new Set(selectedSkills);
    skills = skills.filter((s) => set.has(s.name));
  }
  if (type === "skill") {
    servers = [];
  } else {
    const set = new Set(selectedMcps);
    servers = servers.filter((s) => set.has(s.name));
  }
  return { skills, servers, agentsMd: canonical.agentsMd };
}

// Walk a server's env-var references and return any that aren't set.
function unsetEnvVars(srv: Server): string[] {
  const refs = new Set<string>();
  if (srv.bearerEnvVar) refs.add(srv.bearerEnvVar);
  // Scan headers and env for ${VAR} references.
  const scan = (val: string): void => {
    const re = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
    let m;
    while ((m = re.exec(val)) !== null) {
      if (m[1]) refs.add(m[1]);
    }
  };
  if (srv.headers) {
    for (const v of Object.values(srv.headers)) scan(v);
  }
  if (srv.env) {
    for (const v of Object.values(srv.env)) scan(v);
  }
  const unset: string[] = [];
  for (const ref of refs) {
    const cur = process.env[ref];
    if (cur === undefined || cur.length === 0) unset.push(ref);
  }
  return unset.sort();
}

// Build a per-emitter summary note from a dry-run reconcile result.
function formatPlanSummary(r: InstallResult): string {
  const lines: string[] = [];
  const counts = new Map<
    string,
    { writes: number; sweeps: number; noops: number }
  >();
  for (const a of r.reconcile.applied) {
    const e = a.emitter;
    const cur = counts.get(e) ?? { writes: 0, sweeps: 0, noops: 0 };
    if (a.kind.endsWith("-sweep")) cur.sweeps++;
    else if ("noop" in a && a.noop) cur.noops++;
    else cur.writes++;
    counts.set(e, cur);
  }
  if (counts.size === 0) {
    lines.push("(no changes)");
  } else {
    for (const [e, c] of counts) {
      lines.push(
        `${e}: ${c.writes} write(s), ${c.sweeps} sweep(s), ${c.noops} no-op(s)`,
      );
    }
  }
  if (r.reconcile.refusals.length > 0) {
    lines.push("");
    lines.push(`refusals: ${r.reconcile.refusals.length}`);
    for (const ref of r.reconcile.refusals) {
      if (ref.kind === "marker-missing") {
        lines.push(`  - ${ref.emitter}: marker missing at ${ref.path}`);
      } else if (ref.kind === "real-dir-conflict") {
        lines.push(`  - ${ref.emitter}: real dir conflict at ${ref.link}`);
      } else {
        lines.push(`  - ${ref.emitter}: real file conflict at ${ref.link}`);
      }
    }
  }
  return lines.join("\n");
}

export async function runInteractiveInstall(
  opts: InteractiveOptions,
): Promise<InteractiveResult> {
  intro("agent-setup");

  // ── Step 1+2: scan source ────────────────────────────────────────────────
  const scanSpinner = spinner();
  scanSpinner.start("Scanning source");

  let materialize: MaterializeResult | null = null;
  let canonical: Canonical;
  let sourcePath: string | null = null;
  try {
    const ref = resolveRepoRef(opts.repo);
    let scanRoot: string;
    if (ref.kind === "local") {
      scanRoot = path.resolve(opts.cwd, ref.path);
    } else {
      // Materialize remote into the project's .agents/ first.
      materialize = await materializeRepo({
        ref,
        destAgentsDir: path.join(opts.cwd, ".agents"),
        force: opts.force,
        dryRun: opts.dryRun,
      });
      scanRoot = opts.cwd;
    }
    try {
      const ds = await discoverSource(scanRoot);
      canonical = ds.canonical;
      sourcePath = ds.sourcePath;
    } catch (e) {
      if (e instanceof NoSourceFoundError) {
        canonical = { skills: [], servers: [], agentsMd: null };
      } else {
        throw e;
      }
    }
    scanSpinner.stop(
      sourcePath !== null ? `Scanned ${sourcePath}` : "No source found",
    );
  } catch (e) {
    scanSpinner.stop("Scan failed");
    log.error((e as Error).message);
    outro("Aborted");
    return { cancelled: true, exitCode: 1 };
  }

  // Pre-resolve scope so we can detect agents at the right root.
  // If the user passed --project/--global, skip the prompt.
  let scope: Scope;
  if (opts.scope !== null) {
    scope = opts.scope;
  } else {
    // Defer scope prompt — but we need scope for detection. Prompt now.
    const r = await prompts.pickScope();
    if (r.cancelled) return { cancelled: true, exitCode: 130 };
    scope = r.scope;
  }
  const targetRoot = scope === "project" ? opts.cwd : homedir();

  // ── Step 2 (cont.): detect agents ────────────────────────────────────────
  const detected = await detectEmitters(ALL_EMITTERS, targetRoot, scope);
  const detectedNames = ALL_EMITTERS.filter(
    (e) => detected.get(e.name) === true,
  ).map((e) => e.name);

  // ── Step 3: agent multi-select ───────────────────────────────────────────
  let selectedAgents: string[];
  if (opts.tool !== null) {
    selectedAgents = opts.tool;
  } else {
    note(
      detectedNames.length > 0
        ? `Detected: ${detectedNames.join(", ")}`
        : "No agents detected — you can still select any to install into.",
      "agents",
    );
    const r = await prompts.pickAgents({
      candidates: ALL_EMITTERS.map((e) => ({
        name: e.name,
        detected: detected.get(e.name) === true,
      })),
    });
    if (r.cancelled) return { cancelled: true, exitCode: 130 };
    selectedAgents = r.selected;
  }
  if (selectedAgents.length === 0) {
    outro("No agents selected, exiting");
    return { cancelled: true, exitCode: 0 };
  }

  // ── Step 4: skills ───────────────────────────────────────────────────────
  let selectedSkills: string[];
  if (opts.type === "mcp") {
    selectedSkills = [];
  } else if (canonical.skills.length === 0) {
    selectedSkills = [];
  } else {
    const r = await prompts.pickSkills({
      skills: canonical.skills.map((s) => ({
        name: s.name,
        description: s.description,
      })),
    });
    if (r.cancelled) return { cancelled: true, exitCode: 130 };
    selectedSkills = r.selected;
  }

  // ── Step 5: mcps ─────────────────────────────────────────────────────────
  let selectedMcps: string[];
  if (opts.type === "skill") {
    selectedMcps = [];
  } else if (canonical.servers.length === 0) {
    selectedMcps = [];
  } else {
    const r = await prompts.pickMcps({
      mcps: canonical.servers.map((s) => ({
        name: s.name,
        description: s.description ?? "",
      })),
    });
    if (r.cancelled) return { cancelled: true, exitCode: 130 };
    selectedMcps = r.selected;
  }

  // ── Step 6: env-var check ────────────────────────────────────────────────
  const selectedMcpSet = new Set(selectedMcps);
  const envWarnings: string[] = [];
  for (const srv of canonical.servers) {
    if (!selectedMcpSet.has(srv.name)) continue;
    const unset = unsetEnvVars(srv);
    if (unset.length > 0) {
      envWarnings.push(`${srv.name}: ${unset.join(", ")}`);
    }
  }
  if (envWarnings.length > 0) {
    note(
      envWarnings.join("\n") +
        "\n\nThese will be written as ${VAR} placeholders; set them before invoking the tool.",
      "env vars not set",
    );
  }

  // Build filtered canonical for the install plan.
  const filteredCanonical = filterCanonical(
    canonical,
    selectedSkills,
    selectedMcps,
    opts.type,
  );

  const baseInstall: InstallOptions = {
    repo: opts.repo,
    scope,
    tool: selectedAgents,
    type: opts.type,
    dryRun: true,
    force: opts.force,
    cwd: opts.cwd,
    canonicalOverride: filteredCanonical,
    ...(opts.generator !== undefined ? { generator: opts.generator } : {}),
  };

  // ── Step 7: dry-run for summary ──────────────────────────────────────────
  const planSpinner = spinner();
  planSpinner.start("Computing install plan");
  let dryResult: InstallResult;
  try {
    dryResult = await runInstall(baseInstall);
    planSpinner.stop("Plan ready");
  } catch (e) {
    planSpinner.stop("Plan failed");
    log.error((e as Error).message);
    outro("Aborted");
    return { cancelled: true, exitCode: 1 };
  }
  note(formatPlanSummary(dryResult), "summary");

  // ── Step 8: confirm ──────────────────────────────────────────────────────
  const conf = await prompts.confirmProceed();
  if (conf.cancelled) return { cancelled: true, exitCode: 130 };
  if (!conf.proceed) {
    outro("Cancelled");
    return { cancelled: true, exitCode: 0 };
  }

  // If user asked for --dry-run, stop here without writing.
  if (opts.dryRun) {
    outro("Dry run — no files written");
    return { cancelled: false, result: dryResult, exitCode: 0 };
  }

  // ── Step 9: execute ──────────────────────────────────────────────────────
  const execSpinner = spinner();
  execSpinner.start("Installing");
  let result: InstallResult;
  try {
    result = await runInstall({ ...baseInstall, dryRun: false });
    execSpinner.stop("Installed");
  } catch (e) {
    execSpinner.stop("Install failed");
    log.error((e as Error).message);
    outro("Aborted");
    return { cancelled: true, exitCode: 1 };
  }
  // Surface materialize stats if we did a remote clone.
  if (materialize) {
    note(
      `copied ${materialize.copiedSkills.length} skill(s), ${materialize.copiedMcps.length} mcp(s)` +
        (materialize.skipped.length > 0
          ? `, ${materialize.skipped.length} skipped`
          : ""),
      "remote materialization",
    );
  }

  // ── Step 10: outro + next steps ──────────────────────────────────────────
  if (result.reconcile.refusals.length > 0) {
    const rlines: string[] = [];
    for (const ref of result.reconcile.refusals) {
      if (ref.kind === "marker-missing") {
        rlines.push(
          `${ref.emitter}: marker missing at ${ref.path} (use --force to overwrite)`,
        );
      } else if (ref.kind === "real-dir-conflict") {
        rlines.push(`${ref.emitter}: real dir at ${ref.link}`);
      } else {
        rlines.push(`${ref.emitter}: real file at ${ref.link}`);
      }
    }
    note(rlines.join("\n"), "refusals");
  }
  if (result.oauthHints.length > 0) {
    const hints = result.oauthHints
      .map((h) => `${h.emitter} / ${h.server}: ${h.hint}`)
      .join("\n");
    note(hints, "oauth login next steps");
  }

  const exitCode =
    result.reconcile.refusals.length > 0 && !opts.force ? 1 : 0;
  outro(exitCode === 0 ? "Done!" : "Done with refusals");
  return { cancelled: false, result, exitCode };
}
