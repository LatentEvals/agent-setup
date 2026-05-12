// Source path resolution for `agent-setup import`.
//
// Given a scope (project | global), the relevant root (cwd or $HOME), and an
// optional --from filter, returns the list of skill-directory roots to walk.

import path from "node:path";

import type { Scope } from "./types.js";

export type Tool = "claude" | "codex" | "cursor" | "gemini" | "opencode";

export const ALL_TOOLS: readonly Tool[] = [
  "claude",
  "codex",
  "cursor",
  "gemini",
  "opencode",
] as const;

export function isTool(s: string): s is Tool {
  return (ALL_TOOLS as readonly string[]).includes(s);
}

export type SourceDir = {
  tool: Tool;
  /** Absolute path to a directory containing one subdir per skill. */
  dir: string;
};

/**
 * Returns every skill-source directory to scan for `import`, at the given
 * scope. `root` is cwd for project scope, $HOME for global scope.
 *
 * Note: at the import target the canonical dir is `.agents/skills/` — we
 * never list it as a *source* because importing from it would be a no-op.
 */
export function sourcePathsFor(
  scope: Scope,
  root: string,
  xdgConfigHome: string,
  fromFilter?: Tool,
): SourceDir[] {
  const tools = fromFilter ? [fromFilter] : ALL_TOOLS;
  const out: SourceDir[] = [];
  for (const tool of tools) {
    for (const dir of dirsFor(tool, scope, root, xdgConfigHome)) {
      out.push({ tool, dir });
    }
  }
  return out;
}

function dirsFor(
  tool: Tool,
  scope: Scope,
  root: string,
  xdgConfigHome: string,
): string[] {
  switch (tool) {
    case "claude":
      // project: <root>/.claude/skills, global: <HOME>/.claude/skills
      return [path.join(root, ".claude", "skills")];
    case "codex":
      return [path.join(root, ".codex", "skills")];
    case "cursor":
      return [path.join(root, ".cursor", "skills")];
    case "gemini":
      // Gemini's extension-bundled skills (`~/.gemini/extensions/<ext>/skills/`)
      // are deferred — they need a filesystem walk to enumerate extensions.
      return [path.join(root, ".gemini", "skills")];
    case "opencode":
      if (scope === "project") {
        return [path.join(root, ".opencode", "skills")];
      }
      return [path.join(xdgConfigHome, "opencode", "skills")];
  }
}
