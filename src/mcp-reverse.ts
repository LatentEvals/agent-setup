// Reverse-translation: per-harness raw MCP entry → canonical Server schema.
//
// Each normalizer is the inverse of the corresponding emitter in
// `src/emitters/*.ts`. Auth bearer headers are parsed back out per the
// source tool's syntax. Inline-secret bearer values are rejected — we
// won't canonicalize plaintext credentials.

import type { Server } from "./schema.js";
import { ServerSchema } from "./schema.js";
import type { Tool } from "./import-sources.js";

export type ReverseError = {
  kind: "reverse-error";
  reason: string;
  warnings?: string[];
};

export type ReverseResult =
  | { kind: "ok"; server: Server; warnings: string[] }
  | ReverseError;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

// ── auth parsers ─────────────────────────────────────────────────────────────

const RE_DOLLAR_BRACE = /^Bearer\s+\$\{([A-Z_][A-Z0-9_]*)\}$/; // ${VAR}
const RE_DOLLAR_BARE = /^Bearer\s+\$([A-Z_][A-Z0-9_]*)$/; // $VAR
const RE_DOLLAR_ENV = /^Bearer\s+\$\{env:([A-Z_][A-Z0-9_]*)\}$/; // ${env:VAR}
const RE_BRACE_ENV = /^Bearer\s+\{env:([A-Z_][A-Z0-9_]*)\}$/; // {env:VAR}

type BearerParse =
  | { kind: "env-var"; envVar: string }
  | { kind: "inline-secret" }
  | { kind: "unrecognized" };

/**
 * Parse an `Authorization: Bearer …` header value using the syntax used by
 * `tool`. Returns the env-var name, an inline-secret signal (which we will
 * refuse to import), or "unrecognized" for shapes that don't look like
 * bearer auth at all (e.g. `Basic …`).
 */
export function parseBearerHeader(headerValue: string, tool: Tool): BearerParse {
  const v = headerValue.trim();
  if (!v.toLowerCase().startsWith("bearer")) {
    return { kind: "unrecognized" };
  }
  let m: RegExpMatchArray | null = null;
  switch (tool) {
    case "claude":
    case "gemini":
      m = v.match(RE_DOLLAR_BRACE) ?? v.match(RE_DOLLAR_BARE);
      break;
    case "cursor":
      m = v.match(RE_DOLLAR_ENV);
      break;
    case "opencode":
      m = v.match(RE_BRACE_ENV);
      break;
    case "codex":
      // Codex bearer auth lives in a top-level field, not in headers. If a
      // codex entry has a literal `Authorization: Bearer …` header, try the
      // common syntaxes and fall through to inline-secret.
      m = v.match(RE_DOLLAR_BRACE) ?? v.match(RE_DOLLAR_BARE);
      break;
  }
  if (m && typeof m[1] === "string") {
    return { kind: "env-var", envVar: m[1] };
  }
  // Got "Bearer …" but the body isn't an env-var reference in this tool's
  // syntax — treat as inline secret (refuse).
  return { kind: "inline-secret" };
}

// ── shared canonical builder ─────────────────────────────────────────────────

type CanonicalDraft = {
  name: string;
  description?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  auth?: "none" | "bearer" | "oauth";
  bearerEnvVar?: string;
};

function buildHeaders(
  raw: Record<string, unknown>,
): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== "string") return null;
    out[k] = v;
  }
  return out;
}

function pack(
  draft: CanonicalDraft,
  warnings: string[],
): ReverseResult {
  // Strip `headers.Authorization` if we extracted an env-var (canonical form
  // carries it as `auth`/`bearerEnvVar` instead).
  if (draft.headers && draft.auth === "bearer") {
    const { Authorization: _drop, ...rest } = draft.headers;
    void _drop;
    if (Object.keys(rest).length === 0) {
      delete draft.headers;
    } else {
      draft.headers = rest;
    }
  }
  // Drop empty optional containers so validation matches the canonical form.
  if (draft.args && draft.args.length === 0) delete draft.args;
  if (draft.env && Object.keys(draft.env).length === 0) delete draft.env;
  if (draft.headers && Object.keys(draft.headers).length === 0) delete draft.headers;
  // If no auth set, default to "none".
  if (draft.auth === undefined) draft.auth = "none";
  try {
    const server = ServerSchema.parse(draft);
    return { kind: "ok", server, warnings };
  } catch (e) {
    const issues = (e as {
      issues?: Array<{ path: (string | number)[]; message: string }>;
    }).issues;
    if (Array.isArray(issues)) {
      const detail = issues
        .map(
          (iss) =>
            `${iss.path.length > 0 ? iss.path.join(".") : "(root)"}: ${iss.message}`,
        )
        .join("; ");
      return {
        kind: "reverse-error",
        reason: `validation failed: ${detail}`,
        warnings,
      };
    }
    return { kind: "reverse-error", reason: (e as Error).message, warnings };
  }
}

// ── stdio shared lift (used by claude/cursor/gemini/codex which all share
//    the same stdio shape) ────────────────────────────────────────────────────

function liftStdioCommon(
  name: string,
  raw: Record<string, unknown>,
): CanonicalDraft {
  const draft: CanonicalDraft = { name };
  if (typeof raw["command"] === "string") draft.command = raw["command"] as string;
  if (isStringArray(raw["args"])) draft.args = raw["args"] as string[];
  if (isPlainObject(raw["env"])) {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw["env"] as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    draft.env = out;
  }
  return draft;
}

// ── per-tool normalizers ─────────────────────────────────────────────────────

export function normalizeFromClaude(raw: unknown, name: string): ReverseResult {
  return normalizeStdHttp(raw, name, "claude");
}

export function normalizeFromCursor(raw: unknown, name: string): ReverseResult {
  return normalizeStdHttp(raw, name, "cursor");
}

export function normalizeFromGemini(raw: unknown, name: string): ReverseResult {
  if (!isPlainObject(raw)) {
    return { kind: "reverse-error", reason: "entry is not an object" };
  }
  const warnings: string[] = [];
  // Gemini stdio shape matches the common case.
  if (typeof raw["command"] === "string") {
    return pack(liftStdioCommon(name, raw), warnings);
  }
  // Gemini HTTP uses `httpUrl` (streamable HTTP) — rename to canonical `url`.
  if (typeof raw["httpUrl"] === "string" || typeof raw["url"] === "string") {
    const url = (raw["httpUrl"] ?? raw["url"]) as string;
    const draft: CanonicalDraft = { name, url };
    if (isPlainObject(raw["headers"])) {
      const headers = buildHeaders(raw["headers"]);
      if (headers === null) {
        return { kind: "reverse-error", reason: "header values must be strings" };
      }
      draft.headers = headers;
      const auth = headers["Authorization"];
      if (typeof auth === "string") {
        const p = parseBearerHeader(auth, "gemini");
        if (p.kind === "env-var") {
          draft.auth = "bearer";
          draft.bearerEnvVar = p.envVar;
        } else if (p.kind === "inline-secret") {
          return {
            kind: "reverse-error",
            reason:
              "inline bearer secret in Authorization header; set up an env var (e.g. ${MY_KEY}) and re-run",
          };
        }
      }
    }
    return pack(draft, warnings);
  }
  return {
    kind: "reverse-error",
    reason: "entry has neither `command` nor `httpUrl`/`url`",
  };
}

export function normalizeFromOpenCode(
  raw: unknown,
  name: string,
): ReverseResult {
  if (!isPlainObject(raw)) {
    return { kind: "reverse-error", reason: "entry is not an object" };
  }
  const warnings: string[] = [];
  const type = raw["type"];
  if (type === "local") {
    // `command: [cmd, ...args]` and `environment` instead of `env`.
    const cmdArr = raw["command"];
    if (!isStringArray(cmdArr) || cmdArr.length === 0) {
      return {
        kind: "reverse-error",
        reason: "opencode `local` entries require a non-empty string-array `command`",
      };
    }
    const draft: CanonicalDraft = {
      name,
      command: cmdArr[0] as string,
    };
    if (cmdArr.length > 1) draft.args = cmdArr.slice(1);
    if (isPlainObject(raw["environment"])) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(
        raw["environment"] as Record<string, unknown>,
      )) {
        if (typeof v === "string") out[k] = v;
      }
      draft.env = out;
    }
    return pack(draft, warnings);
  }
  if (type === "remote") {
    const url = raw["url"];
    if (typeof url !== "string") {
      return { kind: "reverse-error", reason: "opencode `remote` entry requires string `url`" };
    }
    const draft: CanonicalDraft = { name, url };
    if (isPlainObject(raw["headers"])) {
      const headers = buildHeaders(raw["headers"]);
      if (headers === null) {
        return { kind: "reverse-error", reason: "header values must be strings" };
      }
      draft.headers = headers;
      const auth = headers["Authorization"];
      if (typeof auth === "string") {
        const p = parseBearerHeader(auth, "opencode");
        if (p.kind === "env-var") {
          draft.auth = "bearer";
          draft.bearerEnvVar = p.envVar;
        } else if (p.kind === "inline-secret") {
          return {
            kind: "reverse-error",
            reason:
              "inline bearer secret in Authorization header; set up an env var (e.g. {env:MY_KEY}) and re-run",
          };
        }
      }
    }
    return pack(draft, warnings);
  }
  return {
    kind: "reverse-error",
    reason: `opencode entry needs \`type: "local"|"remote"\`, got ${JSON.stringify(type)}`,
  };
}

export function normalizeFromCodex(raw: unknown, name: string): ReverseResult {
  if (!isPlainObject(raw)) {
    return { kind: "reverse-error", reason: "entry is not an object" };
  }
  const warnings: string[] = [];
  if (typeof raw["command"] === "string") {
    return pack(liftStdioCommon(name, raw), warnings);
  }
  if (typeof raw["url"] === "string") {
    const draft: CanonicalDraft = { name, url: raw["url"] };
    let envVarFromField: string | null = null;
    if (typeof raw["bearer_token_env_var"] === "string") {
      envVarFromField = raw["bearer_token_env_var"];
      draft.auth = "bearer";
      draft.bearerEnvVar = envVarFromField;
    }
    if (isPlainObject(raw["headers"])) {
      const headers = buildHeaders(raw["headers"]);
      if (headers === null) {
        return { kind: "reverse-error", reason: "header values must be strings" };
      }
      draft.headers = headers;
      const auth = headers["Authorization"];
      if (typeof auth === "string") {
        const p = parseBearerHeader(auth, "codex");
        if (p.kind === "env-var") {
          if (envVarFromField && envVarFromField !== p.envVar) {
            warnings.push(
              `codex entry has both bearer_token_env_var="${envVarFromField}" and Authorization header referencing ${p.envVar}; using bearer_token_env_var`,
            );
          } else if (!envVarFromField) {
            draft.auth = "bearer";
            draft.bearerEnvVar = p.envVar;
          }
        } else if (p.kind === "inline-secret" && !envVarFromField) {
          return {
            kind: "reverse-error",
            reason:
              "inline bearer secret in Authorization header; set bearer_token_env_var or use ${VAR} syntax and re-run",
          };
        }
      }
    }
    return pack(draft, warnings);
  }
  return {
    kind: "reverse-error",
    reason: "codex entry has neither `command` nor `url`",
  };
}

// Shared body used by Claude and Cursor (identical stdio + HTTP shapes; the
// only difference is the bearer-syntax tool tag passed to parseBearerHeader).
function normalizeStdHttp(
  raw: unknown,
  name: string,
  tool: "claude" | "cursor",
): ReverseResult {
  if (!isPlainObject(raw)) {
    return { kind: "reverse-error", reason: "entry is not an object" };
  }
  const warnings: string[] = [];
  if (typeof raw["command"] === "string") {
    return pack(liftStdioCommon(name, raw), warnings);
  }
  if (typeof raw["url"] === "string") {
    const draft: CanonicalDraft = { name, url: raw["url"] };
    if (isPlainObject(raw["headers"])) {
      const headers = buildHeaders(raw["headers"]);
      if (headers === null) {
        return { kind: "reverse-error", reason: "header values must be strings" };
      }
      draft.headers = headers;
      const auth = headers["Authorization"];
      if (typeof auth === "string") {
        const p = parseBearerHeader(auth, tool);
        if (p.kind === "env-var") {
          draft.auth = "bearer";
          draft.bearerEnvVar = p.envVar;
        } else if (p.kind === "inline-secret") {
          const hint =
            tool === "cursor" ? "${env:MY_KEY}" : "${MY_KEY}";
          return {
            kind: "reverse-error",
            reason: `inline bearer secret in Authorization header; set up an env var (e.g. ${hint}) and re-run`,
          };
        }
      }
    }
    return pack(draft, warnings);
  }
  return {
    kind: "reverse-error",
    reason: `${tool} entry has neither \`command\` nor \`url\``,
  };
}

// ── dispatch by tool name ────────────────────────────────────────────────────

export function normalizeFor(
  tool: Tool,
  raw: unknown,
  name: string,
): ReverseResult {
  switch (tool) {
    case "claude":
      return normalizeFromClaude(raw, name);
    case "codex":
      return normalizeFromCodex(raw, name);
    case "cursor":
      return normalizeFromCursor(raw, name);
    case "gemini":
      return normalizeFromGemini(raw, name);
    case "opencode":
      return normalizeFromOpenCode(raw, name);
  }
}
