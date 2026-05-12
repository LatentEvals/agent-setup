import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  emptyLockfile,
  lockfilePath,
  readLockfile,
  writeLockfile,
  type Lockfile,
} from "../src/lockfile.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "agent-setup-lock-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("lockfile", () => {
  test("emptyLockfile shape", () => {
    const lf = emptyLockfile();
    expect(lf.version).toBe(1);
    expect(lf.owns).toEqual({ skills: {}, mcps: {}, files: {} });
  });

  test("read returns empty when file missing", async () => {
    const lf = await readLockfile("project", root);
    expect(lf.version).toBe(1);
    expect(lf.owns.skills).toEqual({});
    expect(lf.owns.mcps).toEqual({});
    expect(lf.owns.files).toEqual({});
  });

  test("read returns empty on malformed JSON", async () => {
    const file = lockfilePath("project", root);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "{not json", "utf8");
    const lf = await readLockfile("project", root);
    expect(lf.owns.skills).toEqual({});
  });

  test("round-trip identity", async () => {
    const lf: Lockfile = {
      version: 1,
      generator: "agent-setup@test",
      owns: {
        skills: {
          foo: { claude: { kind: "symlink", path: "/x/.claude/skills/foo" } },
        },
        mcps: {
          neon: {
            cursor: { file: "/x/.cursor/mcp.json", ownerKey: "mcpServers.neon" },
          },
        },
        files: {
          "/x/CLAUDE.md": { marker: "<!-- m -->", emitter: "claude" },
        },
      },
    };
    await writeLockfile("project", root, lf);
    const read = await readLockfile("project", root);
    expect(read).toEqual(lf);
  });

  test("write creates parent .agents dir", async () => {
    const lf = emptyLockfile();
    await writeLockfile("project", root, lf);
    const file = lockfilePath("project", root);
    const stat = await fs.stat(file);
    expect(stat.isFile()).toBe(true);
    const text = await fs.readFile(file, "utf8");
    expect(text.endsWith("\n")).toBe(true);
  });
});
