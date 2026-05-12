// Discover and load canonical { skills, servers, agentsMd } from a source root.
//
// Priority for discoverSource:
//   .agents/  → primary, well-typed
//   .claude/  → fallback (claude code's native layout)
// Other tool fallbacks (cursor/codex/gemini/opencode) are deferred for v0.1.

import { promises as fs } from "node:fs";
import path from "node:path";
import matter from "gray-matter";

import {
  LegacyMcpFileSchema,
  ServerSchema,
  SkillSchema,
  SkillFrontmatterRawSchema,
  type Canonical,
  type Server,
  type Skill,
} from "./schema.js";

// ── shared helpers ───────────────────────────────────────────────────────────

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function readDirSafe(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw e;
  }
}

async function readFileOrNull(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, "utf-8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EISDIR") return null;
    throw e;
  }
}

// Normalize a parsed frontmatter object into the canonical Skill shape
// (the parser accepts either `disable-model-invocation` or
// `disableModelInvocation`; we collapse to the camelCase form).
function normalizeSkillFrontmatter(
  raw: Record<string, unknown>,
  body: string,
  dir: string,
): Skill {
  const validated = SkillFrontmatterRawSchema.parse(raw);
  const kebab = validated["disable-model-invocation"];
  const camel = validated.disableModelInvocation;
  const skill: Skill = {
    name: validated.name,
    description: validated.description,
    body,
    dir,
    ...(validated.license !== undefined ? { license: validated.license } : {}),
    ...(validated.paths !== undefined ? { paths: validated.paths } : {}),
    ...(camel !== undefined
      ? { disableModelInvocation: camel }
      : kebab !== undefined
        ? { disableModelInvocation: kebab }
        : {}),
    ...(validated.tags !== undefined ? { tags: validated.tags } : {}),
    ...(validated.homepage !== undefined ? { homepage: validated.homepage } : {}),
    ...(validated.repository !== undefined
      ? { repository: validated.repository }
      : {}),
  };
  return SkillSchema.parse(skill);
}

export async function loadSkillFromDir(skillDir: string): Promise<Skill | null> {
  const skillMd = path.join(skillDir, "SKILL.md");
  const text = await readFileOrNull(skillMd);
  if (text === null) return null;
  const parsed = matter(text);
  const fm = (parsed.data ?? {}) as Record<string, unknown>;
  // gray-matter strips the frontmatter; `parsed.content` is the body.
  try {
    return normalizeSkillFrontmatter(fm, parsed.content ?? "", skillDir);
  } catch (e) {
    const issues = (e as { issues?: Array<{ path: (string | number)[]; message: string }> }).issues;
    if (Array.isArray(issues) && issues.length > 0) {
      const detail = issues
        .map((iss) => {
          const p = iss.path.length > 0 ? iss.path.join(".") : "(root)";
          return `  ${p}: ${iss.message}`;
        })
        .join("\n");
      throw new Error(
        `invalid skill frontmatter in ${skillMd}:\n${detail}`,
      );
    }
    throw new Error(
      `invalid skill frontmatter in ${skillMd}: ${(e as Error).message}`,
    );
  }
}

export async function loadSkillsFromSkillsDir(skillsDir: string): Promise<Skill[]> {
  const entries = await readDirSafe(skillsDir);
  const skills: Skill[] = [];
  for (const entry of entries) {
    const full = path.join(skillsDir, entry);
    let stat;
    try {
      stat = await fs.stat(full);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    const skill = await loadSkillFromDir(full);
    if (skill === null) continue;
    if (skill.name !== entry) {
      throw new Error(
        `skill at ${full} declares name="${skill.name}" but lives in dir "${entry}" (must match)`,
      );
    }
    skills.push(skill);
  }
  // Stable order by name for deterministic emitter output.
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

// Format zod issues as `  field.path: message` lines, mirroring the style
// used throughout this loader.
function formatZodIssues(e: unknown): string | null {
  const issues = (e as { issues?: Array<{ path: (string | number)[]; message: string }> }).issues;
  if (!Array.isArray(issues) || issues.length === 0) return null;
  return issues
    .map((iss) => {
      const p = iss.path.length > 0 ? iss.path.join(".") : "(root)";
      return `  ${p}: ${iss.message}`;
    })
    .join("\n");
}

// Parse a single `.agents/mcp.json` legacy file and return the contained
// servers. The file's top-level shape is validated with
// `LegacyMcpFileSchema`; each entry under `servers` has its key injected
// as `name` and is then run through the canonical `ServerSchema`.
async function loadServersFromLegacyMcpFile(file: string): Promise<Server[]> {
  const text = await readFileOrNull(file);
  if (text === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(
      `failed to parse JSON at ${file}: ${(e as Error).message}`,
    );
  }
  let top;
  try {
    top = LegacyMcpFileSchema.parse(parsed);
  } catch (e) {
    const detail = formatZodIssues(e);
    if (detail !== null) {
      throw new Error(`invalid legacy mcp file at ${file}:\n${detail}`);
    }
    throw new Error(
      `invalid legacy mcp file at ${file}: ${(e as Error).message}`,
    );
  }
  const servers: Server[] = [];
  for (const [name, raw] of Object.entries(top.servers)) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error(
        `invalid mcp server "${name}" in ${file}:\n  (root): expected an object`,
      );
    }
    // The legacy format has the key as the name; inject it (and warn if the
    // entry redundantly carries a different `name` — schema would otherwise
    // accept it silently).
    const merged = { ...(raw as Record<string, unknown>), name };
    let srv;
    try {
      srv = ServerSchema.parse(merged);
    } catch (e) {
      const detail = formatZodIssues(e);
      if (detail !== null) {
        throw new Error(
          `invalid mcp server "${name}" in ${file}:\n${detail}`,
        );
      }
      throw new Error(
        `invalid mcp server "${name}" in ${file}: ${(e as Error).message}`,
      );
    }
    servers.push(srv);
  }
  return servers;
}

async function loadServersFromMcpsDir(mcpsDir: string): Promise<Server[]> {
  const entries = await readDirSafe(mcpsDir);
  const servers: Server[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const full = path.join(mcpsDir, entry);
    const text = await readFileOrNull(full);
    if (text === null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      throw new Error(
        `failed to parse JSON at ${full}: ${(e as Error).message}`,
      );
    }
    let srv;
    try {
      srv = ServerSchema.parse(parsed);
    } catch (e) {
      // Format zod errors with the file path + the offending field path
      // so the user knows exactly which file and field to fix.
      const detail = formatZodIssues(e);
      if (detail !== null) {
        throw new Error(`invalid mcp server in ${full}:\n${detail}`);
      }
      throw new Error(`invalid mcp server in ${full}: ${(e as Error).message}`);
    }
    const stem = entry.slice(0, -".json".length);
    if (srv.name !== stem) {
      throw new Error(
        `mcp at ${full} declares name="${srv.name}" but filename is "${entry}" (must match)`,
      );
    }
    servers.push(srv);
  }
  servers.sort((a, b) => a.name.localeCompare(b.name));
  return servers;
}

// ── primary loader: .agents/ ────────────────────────────────────────────────

// Load MCPs from BOTH `.agents/mcps/<name>.json` and the legacy
// `.agents/mcp.json` single-file. On name conflict, the directory entry
// wins and a one-line warning is collected (callers print to stderr).
export async function loadMcpsFromAgentsLayout(
  agentsDir: string,
): Promise<{ servers: Server[]; warnings: string[] }> {
  const dirServers = await loadServersFromMcpsDir(path.join(agentsDir, "mcps"));
  const legacyServers = await loadServersFromLegacyMcpFile(
    path.join(agentsDir, "mcp.json"),
  );

  const warnings: string[] = [];
  const byName = new Map<string, Server>();
  for (const s of dirServers) byName.set(s.name, s);
  for (const s of legacyServers) {
    if (byName.has(s.name)) {
      warnings.push(
        `agent-setup: '.agents/mcp.json' has server '${s.name}' that's also defined in '.agents/mcps/${s.name}.json' — using the directory version`,
      );
      continue;
    }
    byName.set(s.name, s);
  }
  const servers = [...byName.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  return { servers, warnings };
}

export async function loadFromAgents(root: string): Promise<Canonical> {
  const agentsDir = path.join(root, ".agents");
  const skills = await loadSkillsFromSkillsDir(path.join(agentsDir, "skills"));
  const { servers, warnings } = await loadMcpsFromAgentsLayout(agentsDir);
  for (const w of warnings) {
    process.stderr.write(`${w}\n`);
  }
  const agentsMd = await readFileOrNull(path.join(root, "AGENTS.md"));
  return { skills, servers, agentsMd };
}

// ── fallback loader: .claude/ + .mcp.json ───────────────────────────────────

// Translate a `.mcp.json`-style claude entry back into our canonical Server.
//
// We try to recover `bearerEnvVar` from a header that looks like
// `Authorization: Bearer ${VAR}`. Other headers are dropped (best-effort
// fallback — the README warns this is lossy).
function claudeMcpEntryToServer(name: string, raw: unknown): Server {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`mcp entry "${name}" must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  const out: Record<string, unknown> = { name };

  const command = obj["command"];
  const url = obj["url"];
  if (typeof command === "string" && command.length > 0) {
    out["command"] = command;
    if (Array.isArray(obj["args"])) out["args"] = obj["args"];
    if (
      typeof obj["env"] === "object" &&
      obj["env"] !== null &&
      !Array.isArray(obj["env"])
    ) {
      out["env"] = obj["env"];
    }
    out["auth"] = "none";
  } else if (typeof url === "string" && url.length > 0) {
    out["url"] = url;
    let bearerEnvVar: string | undefined;
    if (
      typeof obj["headers"] === "object" &&
      obj["headers"] !== null &&
      !Array.isArray(obj["headers"])
    ) {
      const headers = obj["headers"] as Record<string, unknown>;
      const auth = headers["Authorization"] ?? headers["authorization"];
      if (typeof auth === "string") {
        const m = auth.match(/^Bearer\s+\$\{([A-Za-z_][A-Za-z0-9_]*)\}\s*$/);
        if (m) bearerEnvVar = m[1];
      }
    }
    if (bearerEnvVar !== undefined) {
      out["auth"] = "bearer";
      out["bearerEnvVar"] = bearerEnvVar;
    } else {
      out["auth"] = "none";
    }
  } else {
    throw new Error(
      `mcp entry "${name}" has neither \`command\` nor \`url\` (cannot infer transport)`,
    );
  }

  return ServerSchema.parse(out);
}

async function loadServersFromClaudeMcpJson(file: string): Promise<Server[]> {
  const text = await readFileOrNull(file);
  if (text === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`failed to parse JSON at ${file}: ${(e as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null) return [];
  const top = parsed as Record<string, unknown>;
  const map = top["mcpServers"];
  if (typeof map !== "object" || map === null || Array.isArray(map)) return [];
  const servers: Server[] = [];
  for (const [name, raw] of Object.entries(map as Record<string, unknown>)) {
    servers.push(claudeMcpEntryToServer(name, raw));
  }
  servers.sort((a, b) => a.name.localeCompare(b.name));
  return servers;
}

export async function loadFromClaudeFallback(root: string): Promise<Canonical> {
  const skills = await loadSkillsFromSkillsDir(
    path.join(root, ".claude", "skills"),
  );
  const servers = await loadServersFromClaudeMcpJson(
    path.join(root, ".mcp.json"),
  );
  const agentsMd =
    (await readFileOrNull(path.join(root, "AGENTS.md"))) ??
    (await readFileOrNull(path.join(root, "CLAUDE.md")));
  return { skills, servers, agentsMd };
}

// ── discovery ───────────────────────────────────────────────────────────────

// Sentinel error: "no source found at all" — distinct from parse/schema
// errors so install.ts can treat the missing-source case as "empty" while
// still surfacing real validation errors to the user.
export class NoSourceFoundError extends Error {
  constructor(root: string) {
    super(
      `no source found at ${root}: expected .agents/ or .claude/ (or .mcp.json)`,
    );
    this.name = "NoSourceFoundError";
  }
}

export async function discoverSource(
  root: string,
): Promise<{ canonical: Canonical; sourcePath: string }> {
  const agentsDir = path.join(root, ".agents");
  if (await pathExists(agentsDir)) {
    return { canonical: await loadFromAgents(root), sourcePath: agentsDir };
  }
  const claudeDir = path.join(root, ".claude");
  const claudeMcp = path.join(root, ".mcp.json");
  if ((await pathExists(claudeDir)) || (await pathExists(claudeMcp))) {
    return {
      canonical: await loadFromClaudeFallback(root),
      sourcePath: claudeDir,
    };
  }
  throw new NoSourceFoundError(root);
}
