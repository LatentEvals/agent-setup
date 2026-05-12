// Hand-rolled argv parser + dispatcher for `agent-setup`.
//
// Subcommands:
//   agent-setup [install]     (default verb)
//   agent-setup uninstall <name> | --all
//
// Flags (see README "Common flags"):
//   --type=skill|mcp
//   --project / --global
//   --tool=claude,codex,...
//   --repo <source>
//   --dry-run
//   --force
//   --yes / -y
//   --version / -v
//   --help / -h
//
// v0.1-alpha non-interactive: requires --yes (or non-TTY stdin).
// Remote sources (owner/repo, github.com/..., https://, git@...) are
// shallow-cloned into a tmpdir, materialized into local .agents/, then
// linked.

import { readFileSync } from "node:fs";

import { runInstall, formatInstallSummary, type TypeFilter } from "./install.js";
import { runUninstall } from "./uninstall.js";
import { runInteractiveInstall } from "./ui/flow.js";
import type { Scope } from "./types.js";

type Verb = "install" | "uninstall";

type ParsedArgs = {
  verb: Verb;
  positional: string[];
  type: TypeFilter;
  scope: Scope;
  scopeExplicit: boolean;
  tool: string[] | null;
  repo: string;
  dryRun: boolean;
  force: boolean;
  yes: boolean;
  all: boolean;
  showVersion: boolean;
  showHelp: boolean;
};

type ParseError = { error: string };

function readVersion(): string {
  const pkgUrl = new URL("../package.json", import.meta.url);
  const raw = readFileSync(pkgUrl, "utf-8");
  const parsed = JSON.parse(raw) as { version?: unknown };
  if (typeof parsed.version !== "string") {
    throw new Error("package.json is missing a string `version` field");
  }
  return parsed.version;
}

const HELP = `agent-setup — link your .agents/ to detected AI coding agents

Usage:
  agent-setup [install] [options]
  agent-setup uninstall <name> [options]
  agent-setup uninstall --all [options]

Commands:
  install                Read source and link into detected agents (default).
                         Interactive when run on a TTY without --yes.
  uninstall <name>       Delete <name> from .agents/ and sweep per-tool entries.
                         Non-interactive in v0.1 — requires <name> or --all.
  uninstall --all        Sweep every entry the lockfile owns; preserve .agents/.

Options:
  --repo <source>        Source path or remote URL (default: ".").
  --type=skill|mcp       Narrow to one type (default: both).
  --project              Project scope (default).
  --global               User-home scope.
  --tool=<a,b,...>       Comma-separated allowlist of adapters.
  --dry-run              Preview without writing.
  --force                Bypass marker checks (overwrite hand-written files).
  --yes, -y              Skip prompts (required for non-interactive runs).
  --version, -v          Print version.
  --help, -h             Show this help.

See README.md for full documentation.
`;

function parseArgs(argv: string[]): ParsedArgs | ParseError {
  const out: ParsedArgs = {
    verb: "install",
    positional: [],
    type: "both",
    scope: "project",
    scopeExplicit: false,
    tool: null,
    repo: ".",
    dryRun: false,
    force: false,
    yes: false,
    all: false,
    showVersion: false,
    showHelp: false,
  };

  // First pass: detect verb if first non-flag token is a known verb.
  let i = 0;
  if (argv[0] === "install" || argv[0] === "uninstall") {
    out.verb = argv[0] as Verb;
    i = 1;
  }

  // Track explicit scope flags so we can detect conflicts.
  let scopeSetProject = false;
  let scopeSetGlobal = false;

  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;

    if (a === "--help" || a === "-h") {
      out.showHelp = true;
      continue;
    }
    if (a === "--version" || a === "-v") {
      out.showVersion = true;
      continue;
    }
    if (a === "--dry-run") {
      out.dryRun = true;
      continue;
    }
    if (a === "--force") {
      out.force = true;
      continue;
    }
    if (a === "--yes" || a === "-y") {
      out.yes = true;
      continue;
    }
    if (a === "--all") {
      out.all = true;
      continue;
    }
    if (a === "--project") {
      scopeSetProject = true;
      out.scope = "project";
      continue;
    }
    if (a === "--global") {
      scopeSetGlobal = true;
      out.scope = "global";
      continue;
    }
    if (a === "--repo") {
      const next = argv[i + 1];
      if (next === undefined) {
        return { error: "--repo requires a value" };
      }
      out.repo = next;
      i++;
      continue;
    }
    if (a.startsWith("--repo=")) {
      out.repo = a.slice("--repo=".length);
      continue;
    }
    if (a.startsWith("--type=")) {
      const v = a.slice("--type=".length);
      if (v !== "skill" && v !== "mcp") {
        return { error: `--type must be "skill" or "mcp" (got "${v}")` };
      }
      out.type = v;
      continue;
    }
    if (a === "--type") {
      const next = argv[i + 1];
      if (next !== "skill" && next !== "mcp") {
        return { error: `--type must be "skill" or "mcp"` };
      }
      out.type = next;
      i++;
      continue;
    }
    if (a.startsWith("--tool=")) {
      const v = a.slice("--tool=".length);
      out.tool = v
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      continue;
    }
    if (a === "--tool") {
      const next = argv[i + 1];
      if (next === undefined) {
        return { error: "--tool requires a value" };
      }
      out.tool = next
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      i++;
      continue;
    }
    // Unknown flag.
    if (a.startsWith("-")) {
      return { error: `unknown flag: ${a} (try --help)` };
    }
    // Positional.
    out.positional.push(a);
  }

  if (scopeSetProject && scopeSetGlobal) {
    return { error: "cannot pass both --project and --global" };
  }
  out.scopeExplicit = scopeSetProject || scopeSetGlobal;

  return out;
}

function isTty(): boolean {
  // stdin.isTTY is true when run from a real terminal.
  return Boolean(process.stdin.isTTY);
}

export async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if ("error" in parsed) {
    process.stderr.write(`error: ${parsed.error}\n`);
    return 2;
  }

  if (parsed.showHelp) {
    process.stdout.write(HELP);
    return 0;
  }
  if (parsed.showVersion) {
    process.stdout.write(readVersion() + "\n");
    return 0;
  }

  const cwd = process.cwd();
  const tty = isTty();
  const interactive = parsed.verb === "install" && tty && !parsed.yes;

  if (parsed.verb === "install") {
    if (interactive) {
      const r = await runInteractiveInstall({
        repo: parsed.repo,
        cwd,
        type: parsed.type,
        scope: parsed.scopeExplicit ? parsed.scope : null,
        tool: parsed.tool,
        dryRun: parsed.dryRun,
        force: parsed.force,
      });
      return r.exitCode;
    }
    // Non-TTY (CI/pipes) without --yes is a footgun: prompts can't run, so
    // the install would silently choose its defaults. Refuse and tell the
    // user how to proceed.
    if (!tty && !parsed.yes) {
      process.stderr.write(
        "error: cannot prompt on a non-TTY stdin (CI or pipe). " +
          "Pass --yes to confirm defaults non-interactively.\n",
      );
      return 2;
    }
    const result = await runInstall({
      repo: parsed.repo,
      scope: parsed.scope,
      tool: parsed.tool,
      type: parsed.type,
      dryRun: parsed.dryRun,
      force: parsed.force,
      cwd,
    });
    process.stdout.write(formatInstallSummary(result, parsed.dryRun));
    if (result.reconcile.refusals.length > 0 && !parsed.force) {
      return 1;
    }
    return 0;
  }

  // uninstall
  if (!parsed.all && parsed.positional.length === 0) {
    process.stderr.write(
      "error: uninstall requires either <name> or --all\n",
    );
    return 2;
  }
  if (parsed.all && parsed.positional.length > 0) {
    process.stderr.write(
      "error: uninstall --all does not take a <name> argument\n",
    );
    return 2;
  }

  const name = parsed.all ? null : (parsed.positional[0] as string);
  const result = await runUninstall({
    name,
    all: parsed.all,
    scope: parsed.scope,
    tool: parsed.tool,
    type: parsed.type,
    dryRun: parsed.dryRun,
    force: parsed.force,
    cwd,
    repo: parsed.repo,
  });
  process.stdout.write(formatInstallSummary(result, parsed.dryRun));
  if (result.removedFromSource.length > 0) {
    process.stdout.write(
      `  removed from source: ${result.removedFromSource.length} entr(ies)\n`,
    );
  }
  if (result.reconcile.refusals.length > 0 && !parsed.force) {
    return 1;
  }
  return 0;
}

// Entry: only run when invoked as a script (not when imported by tests).
const invokedAsScript =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("/cli.js") === true ||
  process.argv[1]?.endsWith("\\cli.js") === true;

if (invokedAsScript) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exit(code);
    },
    (err) => {
      process.stderr.write(`agent-setup: ${(err as Error).message}\n`);
      process.exit(1);
    },
  );
}
