// Canonical schemas for .agents/skills/<name>/SKILL.md frontmatter
// and .agents/mcps/<name>.json server declarations.
//
// Strict JSON only (no JSONC). zod v4 is used; .strict() rejects unknown keys.

import { z } from "zod";

// Server-name rules per README:
// lowercase ASCII / digits / hyphens, 1–64 chars, no underscores.
const NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

const NameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(NAME_RE, "name must be lowercase ASCII/digits/hyphens, 1–64 chars, no underscores");

// ── Skill (SKILL.md frontmatter) ─────────────────────────────────────────────
//
// Required: name, description.
// Optional: license, paths (glob array), disable-model-invocation, plus
// registry metadata (tags, homepage, repository).
//
// We're permissive on the disable-model-invocation key spelling: SKILL.md
// frontmatter style varies, so we accept either kebab-case or camelCase
// at parse time and normalize to camelCase on the canonical type.

export const SkillSchema = z
  .object({
    name: NameSchema,
    description: z.string().min(1),
    license: z.string().optional(),
    paths: z.array(z.string()).optional(),
    disableModelInvocation: z.boolean().optional(),
    tags: z.array(z.string()).optional(),
    homepage: z.string().optional(),
    repository: z.string().optional(),
    // The skill body (markdown) and on-disk dir path are attached by the
    // loader, not by the frontmatter parser.
    body: z.string(),
    dir: z.string(),
  })
  .strict();

export type Skill = z.infer<typeof SkillSchema>;

// Helper that accepts raw frontmatter (with kebab-case allowed) and
// normalizes into the strict shape. The loader uses this.
export const SkillFrontmatterRawSchema = z
  .looseObject({
    name: NameSchema,
    description: z.string().min(1),
    license: z.string().optional(),
    paths: z.array(z.string()).optional(),
    "disable-model-invocation": z.boolean().optional(),
    disableModelInvocation: z.boolean().optional(),
    tags: z.array(z.string()).optional(),
    homepage: z.string().optional(),
    repository: z.string().optional(),
  });

// ── Server (.agents/mcps/<name>.json) ────────────────────────────────────────

const AuthSchema = z.enum(["none", "bearer", "oauth"]);

// Header values may reference env vars (e.g. "${VAR}") but inline secrets
// (literal token-looking strings) are rejected lazily at the canonical
// level — the linker policy is "use bearerEnvVar". We allow plain strings
// because some headers are static (e.g. "X-Api-Version: 2024-01") so a
// blanket inline-secret check isn't possible without a heuristic. The
// `auth: "bearer"` case forces `bearerEnvVar` (no inline-token escape hatch).
const HeadersSchema = z.record(z.string(), z.string());

const EnvSchema = z.record(z.string(), z.string());

// We split by transport and then refine for the auth requirement, so that
// errors point at the right field.
const ServerBaseSchema = z
  .object({
    $schema: z.string().optional(),
    name: NameSchema,
    description: z.string().optional(),

    // Transport: exactly one of (command) | (url).
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: EnvSchema.optional(),

    url: z.string().optional(),
    headers: HeadersSchema.optional(),

    auth: AuthSchema.default("none"),
    bearerEnvVar: z.string().optional(),

    // Optional adapter-targeting whitelist.
    targets: z.array(z.string()).optional(),

    // Optional registry-friendly metadata. Linker ignores these; we keep
    // them so loaders don't drop fields on a round-trip.
    tags: z.array(z.string()).optional(),
    homepage: z.string().optional(),
    repository: z.string().optional(),
    license: z.string().optional(),
  })
  .strict();

export const ServerSchema = ServerBaseSchema.superRefine((srv, ctx) => {
  // Exactly one transport.
  const hasCmd = typeof srv.command === "string" && srv.command.length > 0;
  const hasUrl = typeof srv.url === "string" && srv.url.length > 0;
  if (hasCmd === hasUrl) {
    ctx.addIssue({
      code: "custom",
      message: "exactly one of `command` or `url` must be set",
      path: hasCmd ? ["url"] : ["command"],
    });
  }
  // stdio fields only on stdio transports.
  if (!hasCmd) {
    if (srv.args !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "`args` is only valid with stdio (`command`) transport",
        path: ["args"],
      });
    }
    if (srv.env !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "`env` is only valid with stdio (`command`) transport",
        path: ["env"],
      });
    }
  }
  // HTTP fields only on HTTP transports.
  if (!hasUrl) {
    if (srv.headers !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "`headers` is only valid with HTTP (`url`) transport",
        path: ["headers"],
      });
    }
  }
  // Auth invariants.
  if (srv.auth === "bearer") {
    if (typeof srv.bearerEnvVar !== "string" || srv.bearerEnvVar.length === 0) {
      ctx.addIssue({
        code: "custom",
        message: "`auth: \"bearer\"` requires `bearerEnvVar`",
        path: ["bearerEnvVar"],
      });
    }
  } else {
    if (srv.bearerEnvVar !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "`bearerEnvVar` is only valid with `auth: \"bearer\"`",
        path: ["bearerEnvVar"],
      });
    }
  }
});

export type Server = z.infer<typeof ServerSchema>;

// ── Legacy `.agents/mcp.json` (single-file) ──────────────────────────────────
//
// Older repos predate the per-file `.agents/mcps/<name>.json` layout and
// declare every server inline under a top-level `servers` map keyed by name.
// Each entry omits its `name` field — the map key IS the name. The loader
// injects `name: <key>` before validating each entry with `ServerSchema`.
//
// We `.passthrough()` extra top-level keys so docs-style annotations like
// `_doc` or vendor extensions don't make legacy files fail to parse.
export const LegacyMcpFileSchema = z
  .looseObject({
    $schema: z.string().optional(),
    _doc: z.string().optional(),
    servers: z.record(z.string(), z.unknown()),
  });

export type LegacyMcpFile = z.infer<typeof LegacyMcpFileSchema>;

// Top-level canonical bundle assembled by the loader.
export type Canonical = {
  skills: Skill[];
  servers: Server[];
  agentsMd: string | null;
};
