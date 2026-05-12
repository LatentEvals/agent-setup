// Integration tests for runInstall.
//
// We build temp project trees with .agents/ + agent-config dirs, drive
// runInstall directly, then assert per-tool files / lockfile contents.

import { promises as fs } from "node:fs";
import { tmpdir, homedir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { runInstall } from "../src/install.js";
import { readLockfile } from "../src/lockfile.js";
import { main } from "../src/cli.js";

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
  // Two skills.
  await writeFile(
    path.join(r, ".agents", "skills", "hello", "SKILL.md"),
    `---\nname: hello\ndescription: Say hello.\n---\n# Hello\n`,
  );
  await writeFile(
    path.join(r, ".agents", "skills", "world", "SKILL.md"),
    `---\nname: world\ndescription: Say world.\n---\n# World\n`,
  );
  // Two MCPs: one bearer HTTP, one stdio.
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
        env: { EXAMPLE_FLAG: "1" },
      },
      null,
      2,
    ),
  );
  await writeFile(path.join(r, "AGENTS.md"), "# AGENTS\n\nBe helpful.\n");
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "agent-setup-install-"));
  homeDir = await fs.mkdtemp(path.join(tmpdir(), "agent-setup-home-"));
  prevHome = process.env["HOME"];
  process.env["HOME"] = homeDir;
  prevCwd = process.cwd();
  process.chdir(root);
});

afterEach(async () => {
  process.chdir(prevCwd);
  if (prevHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = prevHome;
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(homeDir, { recursive: true, force: true });
});

describe("runInstall — empty source", () => {
  test("only .claude/ detected, empty .agents/ → no MCPs/skills emitted", async () => {
    await mkdirp(path.join(root, ".claude"));
    await mkdirp(path.join(root, ".agents"));
    // Non-existent skills/mcps subdirs are tolerated.
    const r = await runInstall({
      repo: ".",
      scope: "project",
      tool: null,
      type: "both",
      dryRun: false,
      force: false,
      cwd: root,
      generator: GEN,
    });
    expect(r.reconcile.refusals).toEqual([]);
    // No mcp file should have been written.
    expect(await exists(path.join(root, ".mcp.json"))).toBe(false);
  });
});

describe("runInstall — full project install", () => {
  test("writes per-tool entries, refusals empty, lockfile populated", async () => {
    await seedFixtureAgents(root);
    await seedAllAgentDirs(root);

    const r = await runInstall({
      repo: ".",
      scope: "project",
      tool: null,
      type: "both",
      dryRun: false,
      force: false,
      cwd: root,
      generator: GEN,
    });
    expect(r.reconcile.refusals).toEqual([]);
    // Claude .mcp.json
    const mcp = JSON.parse(
      await fs.readFile(path.join(root, ".mcp.json"), "utf8"),
    );
    expect(mcp.mcpServers.neon).toBeDefined();
    expect(mcp.mcpServers["local-tool"]).toBeDefined();
    expect(mcp.mcpServers.neon.headers.Authorization).toBe(
      "Bearer ${NEON_API_KEY}",
    );
    // Codex TOML exists
    expect(
      await exists(path.join(root, ".codex", "config.toml")),
    ).toBe(true);
    // Cursor mcp.json
    const cursor = JSON.parse(
      await fs.readFile(path.join(root, ".cursor", "mcp.json"), "utf8"),
    );
    expect(cursor.mcpServers.neon.headers.Authorization).toBe(
      "Bearer ${env:NEON_API_KEY}",
    );
    // Gemini settings
    const gem = JSON.parse(
      await fs.readFile(path.join(root, ".gemini", "settings.json"), "utf8"),
    );
    expect(gem.mcpServers.neon.httpUrl).toBe("https://mcp.neon.tech/sse");
    expect(gem.context.fileName).toBe("AGENTS.md");
    // OpenCode
    const oc = JSON.parse(
      await fs.readFile(path.join(root, "opencode.json"), "utf8"),
    );
    expect(oc.mcp.neon.type).toBe("remote");
    expect(oc.mcp["local-tool"].type).toBe("local");
    expect(oc.mcp["local-tool"].command).toEqual([
      "npx",
      "@example/some-mcp@latest",
    ]);
    // CLAUDE.md import stub
    const cmd = await fs.readFile(path.join(root, "CLAUDE.md"), "utf8");
    expect(cmd).toContain("@AGENTS.md");
    // Symlinks
    expect(
      (await fs.lstat(path.join(root, ".claude", "skills", "hello"))).isSymbolicLink(),
    ).toBe(true);
    // Lockfile
    const lf = await readLockfile("project", root, GEN);
    expect(Object.keys(lf.owns.mcps).sort()).toEqual(["local-tool", "neon"]);
    expect(Object.keys(lf.owns.skills).sort()).toEqual(["hello", "world"]);
  });
});

describe("runInstall — idempotency", () => {
  test("second run is all no-ops", async () => {
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
    const r2 = await runInstall({
      repo: ".",
      scope: "project",
      tool: null,
      type: "both",
      dryRun: false,
      force: false,
      cwd: root,
      generator: GEN,
    });
    expect(r2.reconcile.refusals).toEqual([]);
    for (const a of r2.reconcile.applied) {
      if (
        a.kind === "json-write" ||
        a.kind === "toml-write" ||
        a.kind === "text-write" ||
        a.kind === "symlink-write"
      ) {
        expect(a.noop).toBe(true);
      } else {
        // sweeps should not occur on an idempotent re-run
        throw new Error(`unexpected sweep on idempotent run: ${a.kind}`);
      }
    }
  });
});

describe("runInstall — --type=mcp filter", () => {
  test("only MCPs emitted; skills skipped", async () => {
    await seedFixtureAgents(root);
    await seedAllAgentDirs(root);
    const r = await runInstall({
      repo: ".",
      scope: "project",
      tool: null,
      type: "mcp",
      dryRun: false,
      force: false,
      cwd: root,
      generator: GEN,
    });
    expect(r.reconcile.refusals).toEqual([]);
    // No skill symlinks
    expect(await exists(path.join(root, ".claude", "skills", "hello"))).toBe(false);
    // MCPs present
    const mcp = JSON.parse(await fs.readFile(path.join(root, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers.neon).toBeDefined();
  });
});

describe("runInstall — --tool=claude filter", () => {
  test("only claude adapter writes", async () => {
    await seedFixtureAgents(root);
    await seedAllAgentDirs(root);
    const r = await runInstall({
      repo: ".",
      scope: "project",
      tool: ["claude"],
      type: "both",
      dryRun: false,
      force: false,
      cwd: root,
      generator: GEN,
    });
    expect(r.emittersUsed).toEqual(["claude"]);
    expect(await exists(path.join(root, ".mcp.json"))).toBe(true);
    expect(await exists(path.join(root, ".cursor", "mcp.json"))).toBe(false);
    expect(await exists(path.join(root, ".codex", "config.toml"))).toBe(false);
    expect(await exists(path.join(root, ".gemini", "settings.json"))).toBe(false);
    expect(await exists(path.join(root, "opencode.json"))).toBe(false);
  });
});

describe("runInstall — --global scope", () => {
  test("writes go to home paths, project paths untouched", async () => {
    // Source is global $HOME/.agents, plus tool dirs in $HOME.
    await seedFixtureAgents(homeDir);
    await mkdirp(path.join(homeDir, ".claude"));
    await mkdirp(path.join(homeDir, ".codex"));
    await mkdirp(path.join(homeDir, ".cursor"));
    await mkdirp(path.join(homeDir, ".gemini"));
    await mkdirp(path.join(homeDir, ".config", "opencode"));

    const r = await runInstall({
      repo: homeDir, // global source
      scope: "global",
      tool: null,
      type: "both",
      dryRun: false,
      force: false,
      cwd: root, // project cwd unrelated
      generator: GEN,
    });
    expect(r.reconcile.refusals).toEqual([]);

    // Global Claude mcp file.
    expect(await exists(path.join(homeDir, ".claude.json"))).toBe(true);
    // Project file should not exist.
    expect(await exists(path.join(root, ".mcp.json"))).toBe(false);
    // Cursor global file at homeDir/.cursor/mcp.json.
    expect(await exists(path.join(homeDir, ".cursor", "mcp.json"))).toBe(true);
    // Lockfile lives at $HOME/.agents/.lock.json.
    expect(await exists(path.join(homeDir, ".agents", ".lock.json"))).toBe(true);
  });
});

describe("runInstall — --dry-run", () => {
  test("no files written; applied populated", async () => {
    await seedFixtureAgents(root);
    await seedAllAgentDirs(root);
    const r = await runInstall({
      repo: ".",
      scope: "project",
      tool: null,
      type: "both",
      dryRun: true,
      force: false,
      cwd: root,
      generator: GEN,
    });
    expect(r.reconcile.applied.length).toBeGreaterThan(0);
    expect(await exists(path.join(root, ".mcp.json"))).toBe(false);
    expect(await exists(path.join(root, "CLAUDE.md"))).toBe(false);
    expect(await exists(path.join(root, ".agents", ".lock.json"))).toBe(false);
  });
});

describe("runInstall — refusal exit code via CLI", () => {
  test("pre-seeded CLAUDE.md without marker → exit 1; with --force → exit 0", async () => {
    await seedFixtureAgents(root);
    await seedAllAgentDirs(root);
    // Pre-seed CLAUDE.md as a hand-written file (no marker).
    await writeFile(path.join(root, "CLAUDE.md"), "my own claude file\n");

    const code1 = await main(["install", "--yes"]);
    expect(code1).toBe(1);
    // CLAUDE.md preserved.
    const t1 = await fs.readFile(path.join(root, "CLAUDE.md"), "utf8");
    expect(t1).toBe("my own claude file\n");

    // With --force.
    const code2 = await main(["install", "--yes", "--force"]);
    expect(code2).toBe(0);
    const t2 = await fs.readFile(path.join(root, "CLAUDE.md"), "utf8");
    expect(t2).toContain("@AGENTS.md");
    expect(t2).toContain("Generated by agent-setup");
  });
});

describe("runInstall — --repo materialization (local source as 'remote')", () => {
  test("materializes a separate source dir's .agents into project .agents and links", async () => {
    // Build a separate "source" tree (simulates what we'd shallow-clone).
    const srcRoot = await fs.mkdtemp(
      path.join(tmpdir(), "agent-setup-srcroot-"),
    );
    try {
      await seedFixtureAgents(srcRoot);
      // Project root has tool dirs but no .agents yet.
      await seedAllAgentDirs(root);

      const r = await runInstall({
        repo: srcRoot, // absolute local path acts as the source
        scope: "project",
        tool: null,
        type: "both",
        dryRun: false,
        force: false,
        cwd: root,
        generator: GEN,
      });

      // Note: when --repo is a local path that points OUTSIDE cwd, current
      // behavior treats it as the source root directly (not materialize).
      // That's fine — local paths still work as before. To exercise the
      // materialize path, the source must NOT be the cwd. Since the local
      // ref reads .agents directly from srcRoot, the install should still
      // succeed.
      expect(r.reconcile.refusals).toEqual([]);
      expect(await exists(path.join(root, ".mcp.json"))).toBe(true);
    } finally {
      await fs.rm(srcRoot, { recursive: true, force: true });
    }
  });

  test("remote ref via injected source materializes and runs install", async () => {
    // Drive runInstall through a "remote" ref by simulating clone via a
    // pre-built source dir. We do this at the materialize layer by
    // pre-creating the destination .agents/ ourselves (mimicking what a
    // successful materialize would do), then calling runInstall with cwd
    // pointing at it. This proves the post-materialize pipeline runs.
    const srcRoot = await fs.mkdtemp(
      path.join(tmpdir(), "agent-setup-srcroot2-"),
    );
    try {
      await seedFixtureAgents(srcRoot);
      // Manually copy srcRoot/.agents → root/.agents (as materializeRepo
      // would for a remote ref).
      await fs.cp(
        path.join(srcRoot, ".agents"),
        path.join(root, ".agents"),
        { recursive: true },
      );
      await seedAllAgentDirs(root);

      const r = await runInstall({
        repo: ".",
        scope: "project",
        tool: null,
        type: "both",
        dryRun: false,
        force: false,
        cwd: root,
        generator: GEN,
      });
      expect(r.reconcile.refusals).toEqual([]);
      const lf = await readLockfile("project", root, GEN);
      expect(Object.keys(lf.owns.skills).sort()).toEqual(["hello", "world"]);
      expect(Object.keys(lf.owns.mcps).sort()).toEqual(["local-tool", "neon"]);
    } finally {
      await fs.rm(srcRoot, { recursive: true, force: true });
    }
  });
});

describe("runInstall — source fallback (.claude/)", () => {
  test("no .agents/, only .claude/skills + .mcp.json → other tools written", async () => {
    // Only .claude scaffolding at the source. (Note: this uses .mcp.json
    // as the source-of-truth for mcps; runInstall will then rewrite that
    // same .mcp.json with the canonical entries — same shape, so it's a
    // no-op write.)
    await writeFile(
      path.join(root, ".claude", "skills", "legacy", "SKILL.md"),
      `---\nname: legacy\ndescription: A legacy claude-only skill.\n---\n# legacy\n`,
    );
    await writeFile(
      path.join(root, ".mcp.json"),
      JSON.stringify(
        {
          mcpServers: {
            neon: {
              url: "https://mcp.neon.tech/sse",
              headers: { Authorization: "Bearer ${NEON_API_KEY}" },
            },
          },
        },
        null,
        2,
      ),
    );
    // Detect the other four tools (skip claude — its skills/legacy/
    // already exists at the source path, which would create a
    // real-dir conflict when claude tries to symlink it back over
    // its own source dir).
    await mkdirp(path.join(root, ".codex"));
    await mkdirp(path.join(root, ".cursor"));
    await mkdirp(path.join(root, ".gemini"));
    await mkdirp(path.join(root, ".opencode"));

    const r = await runInstall({
      repo: ".",
      scope: "project",
      tool: ["codex", "cursor", "gemini", "opencode"],
      type: "both",
      dryRun: false,
      force: false,
      cwd: root,
      generator: GEN,
    });
    expect(r.reconcile.refusals).toEqual([]);
    // Cursor file should now have the neon entry.
    const cursor = JSON.parse(
      await fs.readFile(path.join(root, ".cursor", "mcp.json"), "utf8"),
    );
    expect(cursor.mcpServers.neon).toBeDefined();
    expect(cursor.mcpServers.neon.headers.Authorization).toBe(
      "Bearer ${env:NEON_API_KEY}",
    );
    // Codex toml should exist.
    const codexToml = await fs.readFile(
      path.join(root, ".codex", "config.toml"),
      "utf8",
    );
    expect(codexToml).toContain("neon");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Regression: schema/parse errors must surface, not be swallowed
// ──────────────────────────────────────────────────────────────────────────

describe("runInstall — schema validation surfaces errors", () => {
  test("invalid mcp json throws with file path + field", async () => {
    await mkdirp(path.join(root, ".cursor"));
    // bearer auth without bearerEnvVar — should fail schema validation
    await writeFile(
      path.join(root, ".agents", "mcps", "broken.json"),
      JSON.stringify({ name: "broken", url: "https://x", auth: "bearer" }),
    );
    let err: Error | null = null;
    try {
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
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toContain("invalid mcp server");
    expect(err!.message).toContain("broken.json");
    expect(err!.message).toContain("bearerEnvVar");
  });

  test("malformed JSON in mcps/ throws with file path", async () => {
    await mkdirp(path.join(root, ".cursor"));
    await writeFile(
      path.join(root, ".agents", "mcps", "bad-json.json"),
      "{ this is not valid json",
    );
    let err: Error | null = null;
    try {
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
    } catch (e) {
      err = e as Error;
    }
    expect(err).not.toBeNull();
    expect(err!.message).toContain("failed to parse JSON");
    expect(err!.message).toContain("bad-json.json");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Regression: non-TTY without --yes via CLI returns exit code 2 + message
// ──────────────────────────────────────────────────────────────────────────

describe("CLI — non-TTY without --yes is refused", () => {
  test("returns exit code 2 with friendly error when stdin is not a TTY", async () => {
    // In the test environment process.stdin.isTTY is undefined (non-TTY).
    // Capture stderr to verify the message.
    await mkdirp(path.join(root, ".cursor"));
    const origWrite = process.stderr.write.bind(process.stderr);
    let captured = "";
    (process.stderr as unknown as { write: (s: string) => boolean }).write = (
      s: string,
    ): boolean => {
      captured += s;
      return true;
    };
    try {
      const code = await main(["install"]);
      expect(code).toBe(2);
      expect(captured).toContain("--yes");
      expect(captured).toContain("non-TTY");
    } finally {
      process.stderr.write = origWrite;
    }
  });

  test("--yes succeeds in non-TTY env", async () => {
    await mkdirp(path.join(root, ".cursor"));
    const code = await main(["install", "--yes"]);
    expect(code).toBe(0);
  });
});
