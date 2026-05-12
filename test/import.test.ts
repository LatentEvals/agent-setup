// Integration tests for runImport.

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { runImport } from "../src/import.js";

let root: string;
let homeDir: string;
let prevHome: string | undefined;
let prevCwd: string;
let prevXdg: string | undefined;

async function writeFile(p: string, body: string): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, body, "utf8");
}

function skillMd(name: string, body = "default body"): string {
  return `---\nname: ${name}\ndescription: A test skill named ${name}.\n---\n# ${name}\n${body}\n`;
}

async function readSkillBody(p: string): Promise<string> {
  return await fs.readFile(p, "utf8");
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "agent-setup-import-"));
  homeDir = await fs.mkdtemp(path.join(tmpdir(), "agent-setup-import-home-"));
  prevHome = process.env["HOME"];
  process.env["HOME"] = homeDir;
  prevXdg = process.env["XDG_CONFIG_HOME"];
  delete process.env["XDG_CONFIG_HOME"];
  prevCwd = process.cwd();
  process.chdir(root);
});

afterEach(async () => {
  process.chdir(prevCwd);
  if (prevHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = prevHome;
  if (prevXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
  else process.env["XDG_CONFIG_HOME"] = prevXdg;
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(homeDir, { recursive: true, force: true });
});

describe("runImport — single source", () => {
  test("copies a skill from .claude/skills/ into .agents/skills/", async () => {
    await writeFile(
      path.join(root, ".claude", "skills", "hello", "SKILL.md"),
      skillMd("hello", "from claude"),
    );
    const result = await runImport({
      cwd: root,
      scope: "project",
      dryRun: false,
      force: false,
    });
    expect(result.imported).toEqual(["hello"]);
    expect(result.skipped).toEqual([]);
    const body = await readSkillBody(
      path.join(root, ".agents", "skills", "hello", "SKILL.md"),
    );
    expect(body).toContain("from claude");
  });

  test("preserves co-located skill assets", async () => {
    await writeFile(
      path.join(root, ".claude", "skills", "hello", "SKILL.md"),
      skillMd("hello"),
    );
    await writeFile(
      path.join(root, ".claude", "skills", "hello", "ref.md"),
      "reference data",
    );
    await runImport({ cwd: root, scope: "project", dryRun: false, force: false });
    const ref = await fs.readFile(
      path.join(root, ".agents", "skills", "hello", "ref.md"),
      "utf8",
    );
    expect(ref).toBe("reference data");
  });

  test("no sources at all → empty result, exit-friendly", async () => {
    const result = await runImport({
      cwd: root,
      scope: "project",
      dryRun: false,
      force: false,
    });
    expect(result.imported).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.actions).toEqual([]);
  });
});

describe("runImport — multi-source", () => {
  test("identical content in two sources → imported once, both noted", async () => {
    const body = skillMd("hello", "same everywhere");
    await writeFile(path.join(root, ".claude", "skills", "hello", "SKILL.md"), body);
    await writeFile(path.join(root, ".cursor", "skills", "hello", "SKILL.md"), body);
    const result = await runImport({
      cwd: root,
      scope: "project",
      dryRun: false,
      force: false,
    });
    expect(result.imported).toEqual(["hello"]);
    const copyAction = result.actions.find((a) => a.kind === "copy");
    expect(copyAction).toBeDefined();
    if (copyAction && copyAction.kind === "copy") {
      expect(copyAction.sources.sort()).toEqual(["claude", "cursor"]);
    }
  });

  test("differing content across sources → skip-conflict, no copy", async () => {
    await writeFile(
      path.join(root, ".claude", "skills", "hello", "SKILL.md"),
      skillMd("hello", "claude version"),
    );
    await writeFile(
      path.join(root, ".cursor", "skills", "hello", "SKILL.md"),
      skillMd("hello", "cursor version"),
    );
    const result = await runImport({
      cwd: root,
      scope: "project",
      dryRun: false,
      force: false,
    });
    expect(result.imported).toEqual([]);
    expect(result.skipped).toEqual(["hello"]);
    const conflict = result.actions.find((a) => a.kind === "skip-conflict");
    expect(conflict).toBeDefined();
    // Dest must not exist.
    const dest = path.join(root, ".agents", "skills", "hello");
    await expect(fs.stat(dest)).rejects.toThrow();
  });

  test("--from filter resolves conflict by picking that tool", async () => {
    await writeFile(
      path.join(root, ".claude", "skills", "hello", "SKILL.md"),
      skillMd("hello", "claude version"),
    );
    await writeFile(
      path.join(root, ".cursor", "skills", "hello", "SKILL.md"),
      skillMd("hello", "cursor version"),
    );
    const result = await runImport({
      cwd: root,
      scope: "project",
      from: "cursor",
      dryRun: false,
      force: false,
    });
    expect(result.imported).toEqual(["hello"]);
    const body = await readSkillBody(
      path.join(root, ".agents", "skills", "hello", "SKILL.md"),
    );
    expect(body).toContain("cursor version");
  });
});

describe("runImport — existing canonical", () => {
  test("already in .agents/ with matching content → silent noop", async () => {
    const body = skillMd("hello", "canonical");
    await writeFile(path.join(root, ".agents", "skills", "hello", "SKILL.md"), body);
    await writeFile(path.join(root, ".claude", "skills", "hello", "SKILL.md"), body);
    const result = await runImport({
      cwd: root,
      scope: "project",
      dryRun: false,
      force: false,
    });
    expect(result.imported).toEqual([]);
    expect(result.skipped).toEqual([]);
    const noop = result.actions.find((a) => a.kind === "noop-already-canonical");
    expect(noop).toBeDefined();
  });

  test("already in .agents/, source differs → skip-existing without --force", async () => {
    await writeFile(
      path.join(root, ".agents", "skills", "hello", "SKILL.md"),
      skillMd("hello", "canonical"),
    );
    await writeFile(
      path.join(root, ".claude", "skills", "hello", "SKILL.md"),
      skillMd("hello", "claude differs"),
    );
    const result = await runImport({
      cwd: root,
      scope: "project",
      dryRun: false,
      force: false,
    });
    expect(result.imported).toEqual([]);
    expect(result.skipped).toEqual(["hello"]);
    const body = await readSkillBody(
      path.join(root, ".agents", "skills", "hello", "SKILL.md"),
    );
    expect(body).toContain("canonical");
  });

  test("--force overwrites existing canonical with source", async () => {
    await writeFile(
      path.join(root, ".agents", "skills", "hello", "SKILL.md"),
      skillMd("hello", "canonical"),
    );
    await writeFile(
      path.join(root, ".claude", "skills", "hello", "SKILL.md"),
      skillMd("hello", "claude wins"),
    );
    const result = await runImport({
      cwd: root,
      scope: "project",
      dryRun: false,
      force: true,
    });
    expect(result.imported).toEqual(["hello"]);
    const body = await readSkillBody(
      path.join(root, ".agents", "skills", "hello", "SKILL.md"),
    );
    expect(body).toContain("claude wins");
  });
});

describe("runImport — symlink no-op", () => {
  test("source is a symlink back into .agents/skills/ → skipped silently", async () => {
    // Set up the canonical, then symlink claude's skill dir to point into it.
    await writeFile(
      path.join(root, ".agents", "skills", "hello", "SKILL.md"),
      skillMd("hello"),
    );
    await fs.mkdir(path.join(root, ".claude", "skills"), { recursive: true });
    await fs.symlink(
      path.join(root, ".agents", "skills", "hello"),
      path.join(root, ".claude", "skills", "hello"),
    );
    const result = await runImport({
      cwd: root,
      scope: "project",
      dryRun: false,
      force: false,
    });
    expect(result.imported).toEqual([]);
    expect(result.skipped).toEqual([]);
    // No skip-invalid, no noop-already-canonical, no copy — the symlink was
    // filtered out before the candidate stage.
    expect(result.actions).toEqual([]);
  });
});

describe("runImport — bad frontmatter", () => {
  test("invalid frontmatter skill is warned-and-skipped, others import", async () => {
    await writeFile(
      path.join(root, ".claude", "skills", "good", "SKILL.md"),
      skillMd("good"),
    );
    await writeFile(
      path.join(root, ".claude", "skills", "bad", "SKILL.md"),
      // Missing required `description`.
      `---\nname: bad\n---\n# Bad\n`,
    );
    const result = await runImport({
      cwd: root,
      scope: "project",
      dryRun: false,
      force: false,
    });
    expect(result.imported).toEqual(["good"]);
    expect(result.skipped).toEqual(["bad"]);
    const invalid = result.actions.find((a) => a.kind === "skip-invalid");
    expect(invalid).toBeDefined();
  });
});

describe("runImport — scope", () => {
  test("--global reads from $HOME and writes into $HOME/.agents/skills/", async () => {
    await writeFile(
      path.join(homeDir, ".claude", "skills", "foo", "SKILL.md"),
      skillMd("foo", "global"),
    );
    const result = await runImport({
      cwd: root,
      scope: "global",
      dryRun: false,
      force: false,
    });
    expect(result.imported).toEqual(["foo"]);
    const body = await readSkillBody(
      path.join(homeDir, ".agents", "skills", "foo", "SKILL.md"),
    );
    expect(body).toContain("global");
    // Project .agents/ must remain untouched.
    await expect(
      fs.stat(path.join(root, ".agents", "skills", "foo")),
    ).rejects.toThrow();
  });
});

describe("runImport — dry-run", () => {
  test("plans without writing anything", async () => {
    await writeFile(
      path.join(root, ".claude", "skills", "hello", "SKILL.md"),
      skillMd("hello"),
    );
    const result = await runImport({
      cwd: root,
      scope: "project",
      dryRun: true,
      force: false,
    });
    expect(result.imported).toEqual(["hello"]);
    // Nothing actually on disk.
    await expect(
      fs.stat(path.join(root, ".agents", "skills", "hello")),
    ).rejects.toThrow();
  });
});
