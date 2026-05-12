// Resolve `--repo` inputs and materialize remote/local sources into a local
// `.agents/` tree.
//
// The materialization step is shared between local and remote refs: for a
// remote ref, we shallow-clone into a tmpdir and treat it as a local source.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { isGitOnPath as defaultIsGitOnPath, shallowClone as defaultShallowClone } from "./git.js";

export type RepoRef =
  | { kind: "local"; path: string }
  | { kind: "remote"; url: string; original: string };

const SHORTHAND_RE = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;
const KNOWN_HOST_PREFIXES = ["github.com/", "gitlab.com/", "bitbucket.org/"];

function expandTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function ensureGitSuffix(url: string): string {
  return url.endsWith(".git") ? url : url + ".git";
}

export function resolveRepoRef(input: string): RepoRef {
  if (typeof input !== "string" || input.length === 0) {
    throw new Error("--repo requires a non-empty value");
  }

  // Local paths.
  if (
    input === "." ||
    input === ".." ||
    input.startsWith("./") ||
    input.startsWith("../") ||
    input.startsWith("/") ||
    input === "~" ||
    input.startsWith("~/")
  ) {
    return { kind: "local", path: expandTilde(input) };
  }

  // Already a full clonable URL.
  if (
    input.startsWith("https://") ||
    input.startsWith("http://") ||
    input.startsWith("ssh://") ||
    input.startsWith("git://") ||
    input.startsWith("git@")
  ) {
    return { kind: "remote", url: input, original: input };
  }

  // Known host prefix → prepend https:// and ensure .git suffix.
  for (const prefix of KNOWN_HOST_PREFIXES) {
    if (input.startsWith(prefix)) {
      return {
        kind: "remote",
        url: ensureGitSuffix("https://" + input),
        original: input,
      };
    }
  }

  // GitHub shorthand: owner/repo.
  if (SHORTHAND_RE.test(input)) {
    return {
      kind: "remote",
      url: `https://github.com/${input}.git`,
      original: input,
    };
  }

  throw new Error(
    `--repo value "${input}" is not a recognized local path or remote URL ` +
      `(expected ".", "./path", "/abs", "owner/repo", "github.com/owner/repo", or a clonable URL)`,
  );
}

// ── materialization ─────────────────────────────────────────────────────────

export type MaterializeSkipped = {
  kind: "skill" | "mcp";
  name: string;
  reason: string;
};

export type MaterializeResult = {
  tmpRoot?: string;
  copiedSkills: string[];
  copiedMcps: string[];
  skipped: MaterializeSkipped[];
};

export type MaterializeOptions = {
  ref: RepoRef;
  destAgentsDir: string;
  force: boolean;
  log?: (msg: string) => void;
  // Test seams.
  cloneFn?: (url: string, dest: string) => Promise<void>;
  isGitOnPathFn?: () => Promise<boolean>;
  // Dry-run: clone+scan but do not copy. Cleanup of any tmpdir still runs.
  dryRun?: boolean;
};

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
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

// Find the source root within a materialized checkout / local repo.
//   <root>/.agents/skills/* + <root>/.agents/mcps/*.json (preferred)
//   <root>/.claude/skills/*                              (fallback)
async function findSkillsAndMcps(srcRoot: string): Promise<{
  skillDirs: { name: string; src: string }[];
  mcpFiles: { name: string; src: string }[];
}> {
  const agentsSkills = path.join(srcRoot, ".agents", "skills");
  const agentsMcps = path.join(srcRoot, ".agents", "mcps");
  const claudeSkills = path.join(srcRoot, ".claude", "skills");

  const skillDirs: { name: string; src: string }[] = [];
  const mcpFiles: { name: string; src: string }[] = [];

  // Prefer .agents/ if either subdir exists.
  const hasAgents = (await pathExists(agentsSkills)) || (await pathExists(agentsMcps));
  if (hasAgents) {
    for (const entry of await readDirSafe(agentsSkills)) {
      const full = path.join(agentsSkills, entry);
      let stat;
      try {
        stat = await fs.stat(full);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      skillDirs.push({ name: entry, src: full });
    }
    for (const entry of await readDirSafe(agentsMcps)) {
      if (!entry.endsWith(".json")) continue;
      const full = path.join(agentsMcps, entry);
      let stat;
      try {
        stat = await fs.stat(full);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      const stem = entry.slice(0, -".json".length);
      mcpFiles.push({ name: stem, src: full });
    }
  } else if (await pathExists(claudeSkills)) {
    for (const entry of await readDirSafe(claudeSkills)) {
      const full = path.join(claudeSkills, entry);
      let stat;
      try {
        stat = await fs.stat(full);
      } catch {
        continue;
      }
      if (!stat.isDirectory()) continue;
      skillDirs.push({ name: entry, src: full });
    }
  }

  skillDirs.sort((a, b) => a.name.localeCompare(b.name));
  mcpFiles.sort((a, b) => a.name.localeCompare(b.name));
  return { skillDirs, mcpFiles };
}

export async function materializeRepo(
  opts: MaterializeOptions,
): Promise<MaterializeResult> {
  const log = opts.log ?? (() => {});
  const isGitOnPathFn = opts.isGitOnPathFn ?? defaultIsGitOnPath;
  const cloneFn = opts.cloneFn ?? defaultShallowClone;

  let scanRoot: string;
  let tmpRoot: string | undefined;

  try {
    if (opts.ref.kind === "local") {
      scanRoot = opts.ref.path;
    } else {
      // Remote: ensure git, clone shallow.
      const hasGit = await isGitOnPathFn();
      if (!hasGit) {
        throw new Error(
          "`git` not found on PATH; install Git or use a local --repo path",
        );
      }
      tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agent-setup-"));
      log(`cloning ${opts.ref.url} → ${tmpRoot}`);
      await cloneFn(opts.ref.url, tmpRoot);
      scanRoot = tmpRoot;
    }

    const { skillDirs, mcpFiles } = await findSkillsAndMcps(scanRoot);

    const copiedSkills: string[] = [];
    const copiedMcps: string[] = [];
    const skipped: MaterializeSkipped[] = [];

    const destSkills = path.join(opts.destAgentsDir, "skills");
    const destMcps = path.join(opts.destAgentsDir, "mcps");

    if (!opts.dryRun) {
      await fs.mkdir(destSkills, { recursive: true });
      await fs.mkdir(destMcps, { recursive: true });
    }

    for (const s of skillDirs) {
      const dst = path.join(destSkills, s.name);
      if (await pathExists(dst)) {
        if (!opts.force) {
          skipped.push({
            kind: "skill",
            name: s.name,
            reason: `destination ${dst} exists (pass --force to overwrite)`,
          });
          continue;
        }
        if (!opts.dryRun) {
          await fs.rm(dst, { recursive: true, force: true });
        }
      }
      if (!opts.dryRun) {
        await fs.cp(s.src, dst, { recursive: true });
      }
      copiedSkills.push(s.name);
    }

    for (const m of mcpFiles) {
      const dst = path.join(destMcps, m.name + ".json");
      if (await pathExists(dst)) {
        if (!opts.force) {
          skipped.push({
            kind: "mcp",
            name: m.name,
            reason: `destination ${dst} exists (pass --force to overwrite)`,
          });
          continue;
        }
        if (!opts.dryRun) {
          await fs.rm(dst, { force: true });
        }
      }
      if (!opts.dryRun) {
        await fs.cp(m.src, dst);
      }
      copiedMcps.push(m.name);
    }

    const result: MaterializeResult = { copiedSkills, copiedMcps, skipped };
    if (tmpRoot !== undefined) result.tmpRoot = tmpRoot;
    return result;
  } finally {
    if (tmpRoot !== undefined) {
      try {
        await fs.rm(tmpRoot, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
  }
}
