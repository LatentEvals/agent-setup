// Integration test: runInstall with a remote `--repo`, with the git layer
// stubbed via vi.mock so no network is touched.

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_AGENTS = path.resolve(here, "fixtures", "sources", "agents");

// Mock the git module so the remote path doesn't require real `git`.
vi.mock("../src/git.js", () => ({
  isGitOnPath: async () => true,
  shallowClone: async (_url: string, dest: string) => {
    // Copy fixture into the tmpdir to simulate a successful clone.
    await fs.cp(FIXTURE_AGENTS, dest, { recursive: true });
  },
}));

const { runInstall } = await import("../src/install.js");
const { readLockfile } = await import("../src/lockfile.js");

let root: string;
let homeDir: string;
let prevHome: string | undefined;
let prevCwd: string;

const GEN = "agent-setup@test";

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function mkdirp(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "agent-setup-remote-"));
  homeDir = await fs.mkdtemp(path.join(tmpdir(), "agent-setup-home-"));
  prevHome = process.env["HOME"];
  process.env["HOME"] = homeDir;
  prevCwd = process.cwd();
  process.chdir(root);
  // Pre-seed tool dirs so emitters detect them as installed.
  await mkdirp(path.join(root, ".claude"));
  await mkdirp(path.join(root, ".codex"));
  await mkdirp(path.join(root, ".cursor"));
  await mkdirp(path.join(root, ".gemini"));
  await mkdirp(path.join(root, ".opencode"));
});

afterEach(async () => {
  process.chdir(prevCwd);
  if (prevHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = prevHome;
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(homeDir, { recursive: true, force: true });
});

describe("runInstall — remote --repo (mocked clone)", () => {
  test("owner/repo shorthand triggers materialize + full install", async () => {
    const r = await runInstall({
      repo: "example/repo",
      scope: "project",
      tool: null,
      type: "both",
      dryRun: false,
      force: false,
      cwd: root,
      generator: GEN,
    });

    expect(r.materialize).not.toBeNull();
    expect(r.materialize?.copiedSkills.sort()).toEqual(["hello", "world"]);
    expect(r.materialize?.copiedMcps.sort()).toEqual(["local-tool", "neon"]);
    expect(r.reconcile.refusals).toEqual([]);

    // The materialized .agents/ should now exist locally.
    expect(
      await exists(path.join(root, ".agents", "skills", "hello", "SKILL.md")),
    ).toBe(true);
    expect(
      await exists(path.join(root, ".agents", "mcps", "neon.json")),
    ).toBe(true);

    // Linker ran: per-tool files written.
    expect(await exists(path.join(root, ".mcp.json"))).toBe(true);
    expect(await exists(path.join(root, ".codex", "config.toml"))).toBe(true);

    // Lockfile populated.
    const lf = await readLockfile("project", root, GEN);
    expect(Object.keys(lf.owns.skills).sort()).toEqual(["hello", "world"]);
    expect(Object.keys(lf.owns.mcps).sort()).toEqual(["local-tool", "neon"]);
  });

  test("dry-run + remote: clone + scan, no copy, no per-tool writes", async () => {
    const r = await runInstall({
      repo: "https://github.com/example/repo.git",
      scope: "project",
      tool: null,
      type: "both",
      dryRun: true,
      force: false,
      cwd: root,
      generator: GEN,
    });
    expect(r.materialize).not.toBeNull();
    // Dry-run: copiedSkills still reports what would be copied.
    expect((r.materialize?.copiedSkills.length ?? 0)).toBeGreaterThan(0);
    // But .agents/ on disk is NOT populated.
    expect(
      await exists(path.join(root, ".agents", "skills", "hello")),
    ).toBe(false);
    // No per-tool files written.
    expect(await exists(path.join(root, ".mcp.json"))).toBe(false);
  });
});
