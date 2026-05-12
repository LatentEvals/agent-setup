// Unit tests for hashDir().

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { hashDir } from "../src/hash-dir.js";

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "hash-dir-test-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function write(p: string, body: string): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, body, "utf8");
}

describe("hashDir", () => {
  test("identical trees hash equal", async () => {
    const a = path.join(root, "a");
    const b = path.join(root, "b");
    await write(path.join(a, "SKILL.md"), "---\nname: x\n---\nbody\n");
    await write(path.join(a, "ref.md"), "ref body");
    await write(path.join(b, "SKILL.md"), "---\nname: x\n---\nbody\n");
    await write(path.join(b, "ref.md"), "ref body");
    expect(await hashDir(a)).toBe(await hashDir(b));
  });

  test("byte-differing files hash unequal", async () => {
    const a = path.join(root, "a");
    const b = path.join(root, "b");
    await write(path.join(a, "SKILL.md"), "one");
    await write(path.join(b, "SKILL.md"), "two");
    expect(await hashDir(a)).not.toBe(await hashDir(b));
  });

  test("different filename hashes unequal", async () => {
    const a = path.join(root, "a");
    const b = path.join(root, "b");
    await write(path.join(a, "SKILL.md"), "x");
    await write(path.join(b, "SKILLS.md"), "x");
    expect(await hashDir(a)).not.toBe(await hashDir(b));
  });

  test("nested dirs hashed consistently regardless of fs read order", async () => {
    const a = path.join(root, "a");
    // Add files in opposite alphabetical order to ensure sorting is normalized.
    await write(path.join(a, "z.md"), "z");
    await write(path.join(a, "a.md"), "a");
    await write(path.join(a, "sub", "m.md"), "m");

    const b = path.join(root, "b");
    await write(path.join(b, "sub", "m.md"), "m");
    await write(path.join(b, "a.md"), "a");
    await write(path.join(b, "z.md"), "z");

    expect(await hashDir(a)).toBe(await hashDir(b));
  });
});
