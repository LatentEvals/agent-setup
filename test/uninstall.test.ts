// Integration tests for runUninstall.

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { runInstall } from "../src/install.js";
import { runUninstall } from "../src/uninstall.js";
import { readLockfile } from "../src/lockfile.js";

let root: string;
let homeDir: string;
let prevHome: string | undefined;
let prevCwd: string;

const GEN = "agent-setup@test";

async function mkdirp(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

async function writeFile(p: string, body: string): Promise<void> {
  await mkdirp(path.dirname(p));
  await fs.writeFile(p, body, "utf8");
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function seedAllAgentDirs(r: string): Promise<void> {
  await mkdirp(path.join(r, ".claude"));
  await mkdirp(path.join(r, ".codex"));
  await mkdirp(path.join(r, ".cursor"));
  await mkdirp(path.join(r, ".gemini"));
  await mkdirp(path.join(r, ".opencode"));
}

async function seedFixtureAgents(r: string): Promise<void> {
  await writeFile(
    path.join(r, ".agents", "skills", "hello", "SKILL.md"),
    `---\nname: hello\ndescription: Say hello.\n---\n# Hello\n`,
  );
  await writeFile(
    path.join(r, ".agents", "skills", "world", "SKILL.md"),
    `---\nname: world\ndescription: Say world.\n---\n# World\n`,
  );
  await writeFile(
    path.join(r, ".agents", "mcps", "neon.json"),
    JSON.stringify(
      {
        name: "neon",
        url: "https://mcp.neon.tech/sse",
        auth: "bearer",
        bearerEnvVar: "NEON_API_KEY",
      },
      null,
      2,
    ),
  );
  await writeFile(
    path.join(r, ".agents", "mcps", "local-tool.json"),
    JSON.stringify(
      {
        name: "local-tool",
        command: "npx",
        args: ["@example/some-mcp@latest"],
      },
      null,
      2,
    ),
  );
  await writeFile(path.join(r, "AGENTS.md"), "# AGENTS\n\nBe helpful.\n");
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "agent-setup-uninst-"));
  homeDir = await fs.mkdtemp(path.join(tmpdir(), "agent-setup-uninst-home-"));
  prevHome = process.env["HOME"];
  process.env["HOME"] = homeDir;
  prevCwd = process.cwd();
  process.chdir(root);

  await seedFixtureAgents(root);
  await seedAllAgentDirs(root);
  await runInstall({
    repo: ".",
    scope: "project",
    tool: null,
    type: "both",
    dryRun: false,
    force: false,
    cwd: root,
    generator: GEN,
  });
});

afterEach(async () => {
  process.chdir(prevCwd);
  if (prevHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = prevHome;
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(homeDir, { recursive: true, force: true });
});

describe("runUninstall — by name", () => {
  test("removes named mcp from .agents/, per-tool configs, lockfile", async () => {
    // Sanity: setup wrote everything.
    let mcp = JSON.parse(await fs.readFile(path.join(root, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers.neon).toBeDefined();

    const r = await runUninstall({
      name: "neon",
      all: false,
      scope: "project",
      tool: null,
      type: "both",
      dryRun: false,
      force: false,
      cwd: root,
      repo: ".",
      generator: GEN,
    });
    expect(r.reconcile.refusals).toEqual([]);
    // .agents/mcps/neon.json gone.
    expect(await exists(path.join(root, ".agents", "mcps", "neon.json"))).toBe(false);
    // Per-tool configs no longer have neon.
    mcp = JSON.parse(await fs.readFile(path.join(root, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers.neon).toBeUndefined();
    expect(mcp.mcpServers["local-tool"]).toBeDefined();
    const cursor = JSON.parse(
      await fs.readFile(path.join(root, ".cursor", "mcp.json"), "utf8"),
    );
    expect(cursor.mcpServers.neon).toBeUndefined();
    // Lockfile no longer tracks neon.
    const lf = await readLockfile("project", root, GEN);
    expect(lf.owns.mcps["neon"]).toBeUndefined();
    expect(lf.owns.mcps["local-tool"]).toBeDefined();
  });
});

describe("runUninstall — --all", () => {
  test("preserves .agents/, sweeps per-tool configs, empties lockfile", async () => {
    const r = await runUninstall({
      name: null,
      all: true,
      scope: "project",
      tool: null,
      type: "both",
      dryRun: false,
      force: false,
      cwd: root,
      repo: ".",
      generator: GEN,
    });
    expect(r.reconcile.refusals).toEqual([]);
    // .agents/ preserved
    expect(await exists(path.join(root, ".agents", "mcps", "neon.json"))).toBe(true);
    expect(await exists(path.join(root, ".agents", "skills", "hello"))).toBe(true);
    // Per-tool configs swept.
    const mcp = JSON.parse(await fs.readFile(path.join(root, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers ?? {}).toEqual({});
    const cursor = JSON.parse(
      await fs.readFile(path.join(root, ".cursor", "mcp.json"), "utf8"),
    );
    expect(cursor.mcpServers ?? {}).toEqual({});
    // Symlinks swept.
    expect(await exists(path.join(root, ".claude", "skills", "hello"))).toBe(false);
    // Lockfile empty.
    const lf = await readLockfile("project", root, GEN);
    expect(lf.owns.mcps).toEqual({});
    expect(lf.owns.skills).toEqual({});
  });
});

describe("runUninstall — by name with --type=skill", () => {
  test("only deletes skill; mcp of same name survives", async () => {
    // Add an mcp named "hello" alongside the skill of the same name.
    await writeFile(
      path.join(root, ".agents", "mcps", "hello.json"),
      JSON.stringify(
        {
          name: "hello",
          command: "echo",
        },
        null,
        2,
      ),
    );
    // Reinstall so the new "hello" mcp is tracked.
    await runInstall({
      repo: ".",
      scope: "project",
      tool: null,
      type: "both",
      dryRun: false,
      force: false,
      cwd: root,
      generator: GEN,
    });

    const r = await runUninstall({
      name: "hello",
      all: false,
      scope: "project",
      tool: null,
      type: "skill",
      dryRun: false,
      force: false,
      cwd: root,
      repo: ".",
      generator: GEN,
    });
    expect(r.reconcile.refusals).toEqual([]);
    // Skill dir gone, mcp file preserved.
    expect(await exists(path.join(root, ".agents", "skills", "hello"))).toBe(false);
    expect(await exists(path.join(root, ".agents", "mcps", "hello.json"))).toBe(true);
    // Per-tool: hello mcp still in .mcp.json, hello skill symlink gone.
    const mcp = JSON.parse(await fs.readFile(path.join(root, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers.hello).toBeDefined();
    expect(await exists(path.join(root, ".claude", "skills", "hello"))).toBe(false);
    const lf = await readLockfile("project", root, GEN);
    expect(lf.owns.mcps["hello"]).toBeDefined();
    expect(lf.owns.skills["hello"]).toBeUndefined();
  });
});
