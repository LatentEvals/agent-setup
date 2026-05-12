// Per-tool detection. "Installed" means: a config dir or marker file
// exists. We do NOT probe $PATH — pure existsSync (well, async stat),
// matching the README's agent-detection table.

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { Scope } from "./types.js";

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function detectClaude(input: {
  root: string;
  scope: Scope;
}): Promise<{ installed: boolean }> {
  if (input.scope === "project") {
    const claudeDir = path.join(input.root, ".claude");
    const claudeMd = path.join(input.root, "CLAUDE.md");
    return { installed: (await exists(claudeDir)) || (await exists(claudeMd)) };
  }
  const override = process.env["CLAUDE_CONFIG_DIR"];
  const dir = override && override.length > 0 ? override : path.join(homedir(), ".claude");
  return { installed: await exists(dir) };
}

export async function detectCodex(input: {
  root: string;
  scope: Scope;
}): Promise<{ installed: boolean }> {
  if (input.scope === "project") {
    return { installed: await exists(path.join(input.root, ".codex")) };
  }
  const override = process.env["CODEX_HOME"];
  const dir = override && override.length > 0 ? override : path.join(homedir(), ".codex");
  return { installed: await exists(dir) };
}

export async function detectCursor(input: {
  root: string;
  scope: Scope;
}): Promise<{ installed: boolean }> {
  if (input.scope === "project") {
    return { installed: await exists(path.join(input.root, ".cursor")) };
  }
  return { installed: await exists(path.join(homedir(), ".cursor")) };
}

export async function detectGemini(input: {
  root: string;
  scope: Scope;
}): Promise<{ installed: boolean }> {
  if (input.scope === "project") {
    return { installed: await exists(path.join(input.root, ".gemini")) };
  }
  return { installed: await exists(path.join(homedir(), ".gemini")) };
}

export async function detectOpencode(input: {
  root: string;
  scope: Scope;
}): Promise<{ installed: boolean }> {
  if (input.scope === "project") {
    return { installed: await exists(path.join(input.root, ".opencode")) };
  }
  const xdg = process.env["XDG_CONFIG_HOME"];
  const base = xdg && xdg.length > 0 ? xdg : path.join(homedir(), ".config");
  return { installed: await exists(path.join(base, "opencode")) };
}
