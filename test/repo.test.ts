// Tests for src/repo.ts: --repo resolution + materialization.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { resolveRepoRef, materializeRepo } from "../src/repo.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_AGENTS = path.resolve(here, "fixtures", "sources", "agents");

let workDir: string;

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  workDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-setup-repo-test-"));
});

afterEach(async () => {
  await fs.rm(workDir, { recursive: true, force: true });
});

describe("resolveRepoRef parsing", () => {
  test("single dot is local", () => {
    expect(resolveRepoRef(".")).toEqual({ kind: "local", path: "." });
  });

  test("./path is local", () => {
    expect(resolveRepoRef("./foo/bar")).toEqual({
      kind: "local",
      path: "./foo/bar",
    });
  });

  test("absolute path is local", () => {
    expect(resolveRepoRef("/abs/path")).toEqual({
      kind: "local",
      path: "/abs/path",
    });
  });

  test("~ tilde expands to homedir", () => {
    const r = resolveRepoRef("~/foo");
    expect(r.kind).toBe("local");
    if (r.kind === "local") {
      expect(r.path).toBe(path.join(os.homedir(), "foo"));
    }
  });

  test("owner/repo shorthand → github https url", () => {
    expect(resolveRepoRef("posthog/agent-skills")).toEqual({
      kind: "remote",
      url: "https://github.com/posthog/agent-skills.git",
      original: "posthog/agent-skills",
    });
  });

  test("github.com/owner/repo → https url with .git", () => {
    expect(resolveRepoRef("github.com/o/r")).toEqual({
      kind: "remote",
      url: "https://github.com/o/r.git",
      original: "github.com/o/r",
    });
  });

  test("gitlab.com path with subgroups", () => {
    const r = resolveRepoRef("gitlab.com/g/sg/p");
    expect(r.kind).toBe("remote");
    if (r.kind === "remote") {
      expect(r.url).toBe("https://gitlab.com/g/sg/p.git");
    }
  });

  test("https URL passed through", () => {
    expect(resolveRepoRef("https://example.com/r.git")).toEqual({
      kind: "remote",
      url: "https://example.com/r.git",
      original: "https://example.com/r.git",
    });
  });

  test("git@ scp URL passed through", () => {
    expect(resolveRepoRef("git@github.com:o/r")).toEqual({
      kind: "remote",
      url: "git@github.com:o/r",
      original: "git@github.com:o/r",
    });
  });

  test("ssh:// URL passed through", () => {
    expect(resolveRepoRef("ssh://git@example.com/r.git")).toEqual({
      kind: "remote",
      url: "ssh://git@example.com/r.git",
      original: "ssh://git@example.com/r.git",
    });
  });

  test("invalid input throws", () => {
    expect(() => resolveRepoRef("not a real spec")).toThrow();
    expect(() => resolveRepoRef("")).toThrow();
  });
});

describe("materializeRepo from local fixture", () => {
  test("copies skills + mcps into destAgentsDir", async () => {
    const dest = path.join(workDir, ".agents");
    const r = await materializeRepo({
      ref: { kind: "local", path: FIXTURE_AGENTS },
      destAgentsDir: dest,
      force: false,
    });
    expect(r.copiedSkills.sort()).toEqual(["hello", "world"]);
    expect(r.copiedMcps.sort()).toEqual(["local-tool", "neon"]);
    expect(r.skipped).toEqual([]);
    expect(
      await exists(path.join(dest, "skills", "hello", "SKILL.md")),
    ).toBe(true);
    expect(await exists(path.join(dest, "mcps", "neon.json"))).toBe(true);
    expect(await exists(path.join(dest, "mcps", "local-tool.json"))).toBe(true);
  });
});

describe("materializeRepo conflict skip", () => {
  test("pre-existing target file is preserved without --force", async () => {
    const dest = path.join(workDir, ".agents");
    await fs.mkdir(path.join(dest, "mcps"), { recursive: true });
    const seeded = path.join(dest, "mcps", "neon.json");
    await fs.writeFile(seeded, "ORIGINAL", "utf8");

    const r = await materializeRepo({
      ref: { kind: "local", path: FIXTURE_AGENTS },
      destAgentsDir: dest,
      force: false,
    });
    expect(r.copiedMcps).not.toContain("neon");
    expect(r.skipped.find((s) => s.name === "neon")).toBeDefined();
    const after = await fs.readFile(seeded, "utf8");
    expect(after).toBe("ORIGINAL");
  });
});

describe("materializeRepo --force overwrites", () => {
  test("force=true replaces existing files", async () => {
    const dest = path.join(workDir, ".agents");
    await fs.mkdir(path.join(dest, "mcps"), { recursive: true });
    const seeded = path.join(dest, "mcps", "neon.json");
    await fs.writeFile(seeded, "ORIGINAL", "utf8");

    const r = await materializeRepo({
      ref: { kind: "local", path: FIXTURE_AGENTS },
      destAgentsDir: dest,
      force: true,
    });
    expect(r.copiedMcps).toContain("neon");
    expect(r.skipped).toEqual([]);
    const after = await fs.readFile(seeded, "utf8");
    expect(after).not.toBe("ORIGINAL");
    expect(after).toContain("neon");
  });
});

describe("materializeRepo with mocked git clone", () => {
  test("creates tmpdir, calls clone, materializes from tmp, cleans up", async () => {
    const dest = path.join(workDir, ".agents");
    let capturedUrl: string | null = null;
    let capturedDest: string | null = null;
    let cloneTmpExistedDuringScan = false;

    const cloneFn = async (url: string, tmpDest: string): Promise<void> => {
      capturedUrl = url;
      capturedDest = tmpDest;
      // Simulate clone by copying the fixture into the tmpdir.
      await fs.cp(FIXTURE_AGENTS, tmpDest, { recursive: true });
      cloneTmpExistedDuringScan = await exists(tmpDest);
    };

    const r = await materializeRepo({
      ref: {
        kind: "remote",
        url: "https://github.com/x/y.git",
        original: "x/y",
      },
      destAgentsDir: dest,
      force: false,
      cloneFn,
      isGitOnPathFn: async () => true,
    });

    expect(capturedUrl).toBe("https://github.com/x/y.git");
    expect(capturedDest).not.toBeNull();
    expect(cloneTmpExistedDuringScan).toBe(true);
    expect(r.copiedSkills.sort()).toEqual(["hello", "world"]);
    expect(r.copiedMcps.sort()).toEqual(["local-tool", "neon"]);
    // tmpdir should now be cleaned up.
    if (capturedDest !== null) {
      expect(await exists(capturedDest)).toBe(false);
    }
  });

  test("cleans up tmpdir even if clone throws", async () => {
    const dest = path.join(workDir, ".agents");
    let capturedDest: string | null = null;
    const cloneFn = async (_url: string, tmpDest: string): Promise<void> => {
      capturedDest = tmpDest;
      throw new Error("simulated clone failure");
    };
    await expect(
      materializeRepo({
        ref: {
          kind: "remote",
          url: "https://example.com/x.git",
          original: "https://example.com/x.git",
        },
        destAgentsDir: dest,
        force: false,
        cloneFn,
        isGitOnPathFn: async () => true,
      }),
    ).rejects.toThrow(/simulated clone failure/);
    if (capturedDest !== null) {
      expect(await exists(capturedDest)).toBe(false);
    }
  });
});

describe("materializeRepo when git is not on PATH", () => {
  test("throws friendly error for remote refs", async () => {
    const dest = path.join(workDir, ".agents");
    await expect(
      materializeRepo({
        ref: {
          kind: "remote",
          url: "https://github.com/x/y.git",
          original: "x/y",
        },
        destAgentsDir: dest,
        force: false,
        isGitOnPathFn: async () => false,
        cloneFn: async () => {
          throw new Error("should not be called");
        },
      }),
    ).rejects.toThrow(/`git` not found on PATH/);
  });
});

describe("materializeRepo dry-run", () => {
  test("scans but does not copy", async () => {
    const dest = path.join(workDir, ".agents");
    const r = await materializeRepo({
      ref: { kind: "local", path: FIXTURE_AGENTS },
      destAgentsDir: dest,
      force: false,
      dryRun: true,
    });
    expect(r.copiedSkills.length).toBeGreaterThan(0);
    expect(await exists(path.join(dest, "skills", "hello"))).toBe(false);
    expect(await exists(path.join(dest, "mcps", "neon.json"))).toBe(false);
  });
});
