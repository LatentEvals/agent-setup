# agent-setup

One declarative source of truth for the skills, MCP servers, and instructions you want every AI coding agent to use.

## The problem

Every AI coding agent stores skills, MCP servers, and instructions in a different file, in a different format, with a different env-var syntax. A team that wants the same setup across Claude Code, Codex, Cursor, Gemini CLI, and OpenCode currently maintains five files in three formats.

`agent-setup` collapses that to one `.agents/` directory and one command.

## Quickstart

```bash
npx @latentevals/agent-setup
```

Detects which agents you have installed, reads `.agents/` (or `.claude/` as a fallback), and writes the matching per-tool config. Re-running with no changes produces no diff.

On a TTY the tool prompts you. In CI pass `--yes`.

## What it writes

| Tool | Skills | MCP file | Instructions |
| --- | --- | --- | --- |
| Claude Code | `.claude/skills/<n>` symlink → `.agents/skills/<n>` | `.mcp.json` | `CLAUDE.md` with `@AGENTS.md` |
| Codex | (reads `.agents/skills/` natively) | `.codex/config.toml` | (reads `AGENTS.md` natively) |
| Cursor | (reads `.agents/skills/` natively, v2.4+) | `.cursor/mcp.json` | (reads `AGENTS.md` natively) |
| Gemini CLI | (reads `.agents/skills/` natively) | `.gemini/settings.json` | (via `context.fileName: "AGENTS.md"`) |
| OpenCode | (reads `.agents/skills/` natively) | `opencode.json` | (reads `AGENTS.md` natively) |

`.agents/` is the committed source of truth. `agent-setup` only writes entries it owns (tracked in `.agents/.lock.json`); hand-added entries in shared files survive re-runs untouched.

## Three verbs

### `install`

Reads `.agents/` and writes per-tool configs.

```bash
npx @latentevals/agent-setup                                  # local .agents/
npx @latentevals/agent-setup --repo latentevals/agent-setup   # remote repo
npx @latentevals/agent-setup --global                          # write to ~/ instead
```

`--repo` accepts a GitHub shorthand (`owner/repo`), a full clone URL (`https://…`, `git@…`, `ssh://…`), or a local path. Remote refs are shallow-cloned and the `.agents/` directory is copied into the local project before linking.

### `import`

The inverse: scans each harness's existing skill dirs and MCP config, and copies what it finds into `.agents/`. Useful when you've been using one tool and want the others to match.

```bash
npx @latentevals/agent-setup import                  # scan all harnesses
npx @latentevals/agent-setup import --from cursor    # one source
npx @latentevals/agent-setup import --type=mcp       # only mcps (or =skill)
```

Decision per entry:

- Found in one source → copy
- Found in multiple sources, identical content → copy once
- Found in multiple sources, differing content → skip; re-run with `--from <tool>` to disambiguate
- Already in `.agents/`, matches source → silent no-op
- Already in `.agents/`, differs from source → skip unless `--force`
- MCP with an inline bearer secret → refused (use an env-var reference)

`import` doesn't write per-tool configs. Run `install` after to propagate.

### `uninstall`

```bash
npx @latentevals/agent-setup uninstall <name>   # remove one entry
npx @latentevals/agent-setup uninstall --all    # sweep every owned entry
```

Deletes from `.agents/` and runs an orphan-sweep so every per-tool config drops the corresponding entry.

## File formats

### `.agents/skills/<name>/SKILL.md`

```markdown
---
name: my-skill
description: One sentence describing when this skill applies.
---

# Body

Markdown content. Sibling files in this directory can be referenced.
```

**Required:** `name` (matches dir name, kebab-case), `description`.
**Optional:** `license`, `paths` (glob auto-trigger), `disable-model-invocation`, plus registry metadata (`tags`, `homepage`, `repository`).

### `.agents/mcps/<name>.json`

One file per server. Filename (without `.json`) must match `name`.

```json
{
  "name": "neon",
  "url": "https://mcp.neon.tech/sse",
  "auth": "bearer",
  "bearerEnvVar": "NEON_API_KEY"
}
```

```json
{
  "name": "local-tool",
  "command": "npx",
  "args": ["@example/some-mcp@latest"],
  "env": { "EXAMPLE_FLAG": "1" }
}
```

- Exactly one of stdio (`command`) or HTTP (`url`).
- `auth`: `"none"` (default), `"bearer"` (HTTP only; requires `bearerEnvVar`), or `"oauth"`.
- Inline secrets in `bearerEnvVar` or headers are rejected.
- Optional `targets: ["claude", "codex", ...]` whitelists which adapters emit this server.
- Server names: lowercase ASCII, digits, hyphens — no underscores (Gemini's parser splits on `_`).

The legacy single-file format `.agents/mcp.json` (a top-level `{ servers: { <name>: {...} } }` map) is also read. Both layouts may coexist; the per-file layout wins on duplicate names.

### `AGENTS.md`

Plain markdown at the project root. Codex, Cursor, Gemini, OpenCode read it natively. For Claude Code, `agent-setup` generates a one-line `CLAUDE.md` containing `@AGENTS.md`.

## Scopes

| Scope | Flag | Reads | Writes |
| --- | --- | --- | --- |
| project | `--project` (default) | `.agents/` | project paths (`.mcp.json`, `.codex/config.toml`, …) |
| global | `--global` | `.agents/` | home paths (`~/.claude.json`, `~/.codex/config.toml`, …) |

Project scope is for team-shared setup committed to source control. Global scope is for personal additions that follow you across all projects.

## Flags

| Flag | Used by | Purpose |
| --- | --- | --- |
| `--repo <src>` | install | Source: `owner/repo`, full URL, or local path (default `.`) |
| `--type=skill\|mcp` | all | Narrow to one type (default: both) |
| `--from=<tool>` | import | Limit scan to one harness |
| `--tool=<a,b,…>` | install/uninstall | Limit which adapters to write |
| `--project` / `--global` | all | Scope (mutually exclusive; project is default) |
| `--dry-run` | all | Preview without writing |
| `--force` | all | Overwrite hand-written files / resolve conflicts |
| `--yes` / `-y` | install | Skip prompts (required for non-TTY) |
| `--version` / `-v`, `--help` / `-h` | — | Print and exit |

## Auth env-var syntax

Every agent uses a different syntax. You declare `bearerEnvVar: "MY_TOKEN"` once; each adapter translates:

| Tool | Emitted form |
| --- | --- |
| Claude Code | `"Authorization": "Bearer ${MY_TOKEN}"` |
| Cursor | `"Authorization": "Bearer ${env:MY_TOKEN}"` |
| Gemini CLI | `"Authorization": "Bearer ${MY_TOKEN}"` |
| OpenCode | `"Authorization": "Bearer {env:MY_TOKEN}"` (no `$`) |
| Codex | `bearer_token_env_var = "MY_TOKEN"` (TOML field, not interpolation) |

`import` reverses the same matrix when reading existing configs.

## OAuth

For MCPs with `auth: "oauth"`, `agent-setup` writes the config but doesn't drive the login flow. Run each tool's first-time command after install:

| Tool | Login |
| --- | --- |
| Claude Code | `/mcp` inside Claude Code |
| Codex | `codex mcp login <name>` |
| Cursor | (auto on first server use) |
| Gemini CLI | `/mcp auth <name>` inside Gemini CLI |
| OpenCode | `opencode mcp auth <name>` (or auto via DCR) |

## Safety

- **Lockfile-tracked ownership.** `.agents/.lock.json` records every entry `agent-setup` wrote. Re-runs only touch owned entries; hand-added MCPs in shared files survive.
- **Marker-protected text files.** Generated files (the `CLAUDE.md` import stub) carry a `# Generated by agent-setup` marker on the first line. Files at managed paths without the marker are refused unless `--force`.
- **Symlink-only management.** A real `.claude/skills/foo/` directory is preserved; only symlinks pointing into `.agents/skills/` are replaced. Orphan symlinks (pointing at deleted skills) are swept.

## What it isn't

- Not a runtime. Doesn't run MCP servers or invoke skills.
- Not an installer for the agents themselves.
- Not an OAuth driver — writes config, you run the per-tool login.
- Not a registry — `--name <slug>` lookup is deferred until something exists to look up.

## Source

TypeScript, Node 20+, distributed via `npx`. Implementation lives in `src/`; per-tool emitters in `src/emitters/`; reconciler at `src/reconcile.ts`; the canonical loader at `src/load-source.ts`. Tests with `vitest run`.
