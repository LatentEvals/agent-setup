// Lockfile read/write helpers.
//
// Schema (v1):
//   {
//     version: 1,
//     generator: "agent-setup@<version>",
//     owns: {
//       skills: { [skillName]: { [emitter]: { kind: "symlink", path } } },
//       mcps:   { [mcpName]:   { [emitter]: { file, ownerKey } } },
//       files:  { [filePath]:  { marker, emitter } },
//     }
//   }
//
// Project scope: <root>/.agents/.lock.json (committed by convention).
// Global scope:  ~/.agents/.lock.json (gitignored — it lives in $HOME/.agents).
//
// No `updatedAt` field — keep churn low so re-runs that change nothing
// produce zero file diffs.

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { Scope } from "./types.js";

export type SkillEmission = { kind: "symlink"; path: string };
export type McpEmission = { file: string; ownerKey: string };
export type FileEmission = { marker: string; emitter: string };

export type Lockfile = {
  version: 1;
  generator: string;
  owns: {
    skills: Record<string, Record<string, SkillEmission>>;
    mcps: Record<string, Record<string, McpEmission>>;
    files: Record<string, FileEmission>;
  };
};

export function lockfilePath(scope: Scope, root: string): string {
  if (scope === "project") {
    return path.join(root, ".agents", ".lock.json");
  }
  return path.join(homedir(), ".agents", ".lock.json");
}

export function emptyLockfile(generator = "agent-setup@0.1.0-alpha.1"): Lockfile {
  return {
    version: 1,
    generator,
    owns: { skills: {}, mcps: {}, files: {} },
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function coerceLockfile(raw: unknown, generator: string): Lockfile {
  // Defensive: tolerate any shape, fall back to empty if structure is wrong.
  if (!isPlainObject(raw)) return emptyLockfile(generator);
  if (raw["version"] !== 1) return emptyLockfile(generator);
  const owns = raw["owns"];
  if (!isPlainObject(owns)) return emptyLockfile(generator);

  const skills: Record<string, Record<string, SkillEmission>> = {};
  const mcps: Record<string, Record<string, McpEmission>> = {};
  const files: Record<string, FileEmission> = {};

  const rawSkills = owns["skills"];
  if (isPlainObject(rawSkills)) {
    for (const [skill, byEmitter] of Object.entries(rawSkills)) {
      if (!isPlainObject(byEmitter)) continue;
      const inner: Record<string, SkillEmission> = {};
      for (const [emitter, emission] of Object.entries(byEmitter)) {
        if (
          isPlainObject(emission) &&
          emission["kind"] === "symlink" &&
          typeof emission["path"] === "string"
        ) {
          inner[emitter] = { kind: "symlink", path: emission["path"] };
        }
      }
      if (Object.keys(inner).length > 0) skills[skill] = inner;
    }
  }

  const rawMcps = owns["mcps"];
  if (isPlainObject(rawMcps)) {
    for (const [name, byEmitter] of Object.entries(rawMcps)) {
      if (!isPlainObject(byEmitter)) continue;
      const inner: Record<string, McpEmission> = {};
      for (const [emitter, emission] of Object.entries(byEmitter)) {
        if (
          isPlainObject(emission) &&
          typeof emission["file"] === "string" &&
          typeof emission["ownerKey"] === "string"
        ) {
          inner[emitter] = { file: emission["file"], ownerKey: emission["ownerKey"] };
        }
      }
      if (Object.keys(inner).length > 0) mcps[name] = inner;
    }
  }

  const rawFiles = owns["files"];
  if (isPlainObject(rawFiles)) {
    for (const [p, emission] of Object.entries(rawFiles)) {
      if (
        isPlainObject(emission) &&
        typeof emission["marker"] === "string" &&
        typeof emission["emitter"] === "string"
      ) {
        files[p] = { marker: emission["marker"], emitter: emission["emitter"] };
      }
    }
  }

  const gen = typeof raw["generator"] === "string" ? raw["generator"] : generator;
  return {
    version: 1,
    generator: gen,
    owns: { skills, mcps, files },
  };
}

export async function readLockfile(
  scope: Scope,
  root: string,
  generator = "agent-setup@0.1.0-alpha.1",
): Promise<Lockfile> {
  const file = lockfilePath(scope, root);
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    return emptyLockfile(generator);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return emptyLockfile(generator);
  }
  return coerceLockfile(parsed, generator);
}

export async function writeLockfile(
  scope: Scope,
  root: string,
  lockfile: Lockfile,
): Promise<void> {
  const file = lockfilePath(scope, root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const body = JSON.stringify(lockfile, null, 2) + "\n";
  // Same-dir tempfile + rename for atomicity.
  const tmp = file + ".tmp";
  await fs.writeFile(tmp, body, "utf8");
  await fs.rename(tmp, file);
}
