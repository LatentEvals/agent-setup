---
name: authoring-agents
description: How to author content under .agents/ — the SKILL.md frontmatter rules and the .agents/mcps/<name>.json schema. Use this skill whenever a user wants to add a new skill or MCP server to a project's .agents/ directory, or needs to know the format constraints (kebab-case names, no underscores, strict JSON, exactly-one-transport, env-var-only secrets).
homepage: https://github.com/latentevals/agent-setup
repository: https://github.com/latentevals/agent-setup
license: MIT
tags: [skills, mcp, authoring, schema]
---

# Authoring `.agents/` content

A project that wants cross-tool setup declares it once under `.agents/`. The directory has two children:

```
.agents/
  skills/
    <name>/
      SKILL.md       # YAML frontmatter + markdown body
      ...            # any sibling files the skill references
  mcps/
    <name>.json      # one MCP server per file
```

`AGENTS.md` at the project root holds shared instructions.

## SKILL.md format

```markdown
---
name: my-skill
description: One sentence describing when this skill applies.
---

# Body

Markdown content. Sibling files in the same directory can be referenced.
```

**Required frontmatter:** `name` (matches the directory name, kebab-case), `description` (one sentence; the model uses this to decide relevance).

**Optional:** `license`, `paths` (glob array — auto-trigger when the agent reads matching files), `disable-model-invocation` (bool — skill is reference-only, not auto-applied).

**Optional registry metadata** (ignored by the linker, used by future discovery): `tags`, `homepage`, `repository`.

## `.agents/mcps/<name>.json` schema

Strict JSON (no comments, no trailing commas). Filename without `.json` must equal the `name` field.

### HTTP server with bearer auth

```json
{
  "name": "neon",
  "description": "Neon Postgres MCP server",
  "url": "https://mcp.neon.tech/sse",
  "auth": "bearer",
  "bearerEnvVar": "NEON_API_KEY",
  "homepage": "https://neon.tech"
}
```

### Stdio server with env passthrough

```json
{
  "name": "local-tool",
  "description": "Some local tool",
  "command": "npx",
  "args": ["@example/some-mcp@latest"],
  "env": { "EXAMPLE_FLAG": "1" }
}
```

### HTTP server with OAuth

```json
{
  "name": "create-webapp",
  "description": "Project's own MCP server",
  "url": "http://localhost:3000/api/mcp",
  "auth": "oauth"
}
```

After install, the linker prints the per-tool first-time login command (`/mcp` in Claude, `codex mcp login <name>`, etc.).

## Hard rules

- **Names are kebab-case, ASCII letters/digits/hyphens, 1–64 chars. No underscores** (Gemini's parser splits on `_`).
- **Exactly one transport** — `command` (stdio) XOR `url` (HTTP). The schema enforces it.
- **No inline secrets.** `auth: "bearer"` requires `bearerEnvVar` (the name of an env var on the user's machine), never a literal token. The linker translates `${NEON_API_KEY}` per-tool to whatever each agent's interpolation syntax expects.
- **Filename, directory name (for skills), and `name` field must agree.**

## Legacy single-file MCP format

`.agents/mcp.json` (single file with a `servers: { <name>: { ... } }` map) is also supported for backward compatibility. The directory layout takes precedence on overlapping names. New projects should prefer one-file-per-server under `.agents/mcps/`.

## After authoring

Run `agent-setup install --yes` from the project root and the new skill or MCP shows up in every detected agent.
