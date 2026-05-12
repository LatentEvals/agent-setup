import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  detectClaude,
  detectCodex,
  detectCursor,
  detectGemini,
  detectOpencode,
} from "../src/detect.js";

let tmp: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "agent-setup-detect-"));
});

afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe("project-scope detection", () => {
  test("claude not detected in empty dir", async () => {
    const out = await detectClaude({ root: tmp, scope: "project" });
    expect(out.installed).toBe(false);
  });

  test("claude detected via .claude/", async () => {
    await fs.mkdir(path.join(tmp, ".claude"));
    const out = await detectClaude({ root: tmp, scope: "project" });
    expect(out.installed).toBe(true);
  });

  test("claude detected via CLAUDE.md alone", async () => {
    await fs.writeFile(path.join(tmp, "CLAUDE.md"), "x");
    const out = await detectClaude({ root: tmp, scope: "project" });
    expect(out.installed).toBe(true);
  });

  test("codex via .codex/", async () => {
    await fs.mkdir(path.join(tmp, ".codex"));
    expect((await detectCodex({ root: tmp, scope: "project" })).installed).toBe(
      true,
    );
  });

  test("cursor via .cursor/", async () => {
    await fs.mkdir(path.join(tmp, ".cursor"));
    expect((await detectCursor({ root: tmp, scope: "project" })).installed).toBe(
      true,
    );
  });

  test("gemini via .gemini/", async () => {
    await fs.mkdir(path.join(tmp, ".gemini"));
    expect((await detectGemini({ root: tmp, scope: "project" })).installed).toBe(
      true,
    );
  });

  test("opencode via .opencode/", async () => {
    await fs.mkdir(path.join(tmp, ".opencode"));
    expect(
      (await detectOpencode({ root: tmp, scope: "project" })).installed,
    ).toBe(true);
  });

  test("all undetected when dir is empty", async () => {
    expect((await detectClaude({ root: tmp, scope: "project" })).installed).toBe(
      false,
    );
    expect((await detectCodex({ root: tmp, scope: "project" })).installed).toBe(
      false,
    );
    expect((await detectCursor({ root: tmp, scope: "project" })).installed).toBe(
      false,
    );
    expect((await detectGemini({ root: tmp, scope: "project" })).installed).toBe(
      false,
    );
    expect(
      (await detectOpencode({ root: tmp, scope: "project" })).installed,
    ).toBe(false);
  });
});

describe("global-scope detection respects env overrides", () => {
  test("claude honors $CLAUDE_CONFIG_DIR", async () => {
    const old = process.env["CLAUDE_CONFIG_DIR"];
    try {
      process.env["CLAUDE_CONFIG_DIR"] = tmp;
      const out = await detectClaude({ root: "/dev/null", scope: "global" });
      expect(out.installed).toBe(true);
    } finally {
      if (old === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
      else process.env["CLAUDE_CONFIG_DIR"] = old;
    }
  });

  test("codex honors $CODEX_HOME", async () => {
    const old = process.env["CODEX_HOME"];
    try {
      process.env["CODEX_HOME"] = tmp;
      const out = await detectCodex({ root: "/dev/null", scope: "global" });
      expect(out.installed).toBe(true);
    } finally {
      if (old === undefined) delete process.env["CODEX_HOME"];
      else process.env["CODEX_HOME"] = old;
    }
  });

  test("opencode honors $XDG_CONFIG_HOME", async () => {
    const old = process.env["XDG_CONFIG_HOME"];
    try {
      process.env["XDG_CONFIG_HOME"] = tmp;
      await fs.mkdir(path.join(tmp, "opencode"));
      const out = await detectOpencode({ root: "/dev/null", scope: "global" });
      expect(out.installed).toBe(true);
    } finally {
      if (old === undefined) delete process.env["XDG_CONFIG_HOME"];
      else process.env["XDG_CONFIG_HOME"] = old;
    }
  });
});
