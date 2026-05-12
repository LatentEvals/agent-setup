// Unit tests for sourcePathsFor().

import path from "node:path";

import { describe, expect, test } from "vitest";

import { sourcePathsFor, ALL_TOOLS } from "../src/import-sources.js";

const ROOT = "/proj";
const XDG = "/home/u/.config";

describe("sourcePathsFor (project scope)", () => {
  test("returns one dir per tool when no filter", () => {
    const out = sourcePathsFor("project", ROOT, XDG);
    expect(out.map((s) => s.tool)).toEqual([...ALL_TOOLS]);
    expect(out.map((s) => s.dir)).toEqual([
      path.join(ROOT, ".claude", "skills"),
      path.join(ROOT, ".codex", "skills"),
      path.join(ROOT, ".cursor", "skills"),
      path.join(ROOT, ".gemini", "skills"),
      path.join(ROOT, ".opencode", "skills"),
    ]);
  });

  test("--from filter narrows to one tool", () => {
    const out = sourcePathsFor("project", ROOT, XDG, "cursor");
    expect(out).toEqual([
      { tool: "cursor", dir: path.join(ROOT, ".cursor", "skills") },
    ]);
  });
});

describe("sourcePathsFor (global scope)", () => {
  const HOME = "/home/u";
  test("opencode uses XDG path at global scope", () => {
    const out = sourcePathsFor("global", HOME, XDG, "opencode");
    expect(out).toEqual([
      { tool: "opencode", dir: path.join(XDG, "opencode", "skills") },
    ]);
  });

  test("opencode uses .opencode/skills at project scope", () => {
    const out = sourcePathsFor("project", ROOT, XDG, "opencode");
    expect(out).toEqual([
      { tool: "opencode", dir: path.join(ROOT, ".opencode", "skills") },
    ]);
  });

  test("non-opencode tools use <root>/.<tool>/skills at global", () => {
    const out = sourcePathsFor("global", HOME, XDG, "claude");
    expect(out).toEqual([
      { tool: "claude", dir: path.join(HOME, ".claude", "skills") },
    ]);
  });
});
