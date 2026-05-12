# agent-setup

One declarative source of truth for the skills, MCP servers, and instructions you want every AI coding agent to use.

---

## The problem

Every AI coding agent stores its skills, MCP servers, and instructions in a different file, in a different format, with different env-var-reference syntax. A team that wants the same setup across Claude Code, Codex, Cursor, Gemini CLI, and OpenCode currently maintains five files in three formats. Add a sixth tool and every consumer updates everywhere.

`agent-setup` collapses that to one `.agents/` directory and one command.

---

## The standard

Declare your project's setup once:

```
.agents/
  skills/
    my-skill/
      SKILL.md           # YAML frontmatter + markdown body
      ...                # any sibling files the skill references
  mcps/                  # recommended: one file per server
    neon.json
    posthog.json
  mcp.json               # legacy: single file, also supported (see below)
AGENTS.md                # project instructions (at repo root)
```

The directory layout (`.agents/mcps/<name>.json`) is recommended for new projects — it makes per-server diffs cleaner and avoids merge conflicts as the registry grows. The legacy single-file `.agents/mcp.json` is also supported (see *File formats* below); both layouts may even coexist in the same repo.

Run `agent-setup` and it wires that into every detected agent in the agent's native format:

- `.claude/skills/my-skill/` becomes a symlink → `.agents/skills/my-skill/`
- `neon` and `posthog` are added to `.mcp.json`, `.cursor/mcp.json`, `.codex/config.toml`, `.gemini/settings.json`, `opencode.json` — each with the correct env-var syntax for that tool
- `CLAUDE.md` is generated as a one-line `@AGENTS.md` import so Claude Code reads the same instructions

Idempotent. Re-running with no changes produces no diff.

---

## Quick start

```bash
# In any project (with .agents/, .claude/, or empty):
npx @latentevals/agent-setup
```

When stdin is a TTY, the tool detects your installed agents and walks you through which skills and MCPs to enable before writing per-tool configs. In CI or any non-TTY context, pass `--yes` to confirm defaults non-interactively (without `--yes`, non-TTY runs exit with an error pointing at the flag).

---

## The three scenarios

### 1. Install from a repo

```bash
npx @latentevals/agent-setup install --repo latentevals/agent-setup            # all skills + mcps
npx @latentevals/agent-setup install --repo latentevals/agent-setup --type=mcp # only mcps
```

`--repo` accepts:

| Input | Resolution |
| --- | --- |
| `owner/repo` | GitHub shorthand → `https://github.com/owner/repo.git` |
| `github.com/owner/repo`, `gitlab.com/...`, `bitbucket.org/...` | known-host shorthand → https URL |
| `https://...`, `http://...`, `ssh://...`, `git://...`, `git@...` | any clonable URL |
| `.`, `./path`, `/abs/path`, `~/path` | local directory |

Omit `--repo` and it defaults to `.` (the current directory). So `install` with no flags links whatever is in your local `.agents/`.

**Remote refs** are shallow-cloned (`git clone --depth=1`) into a tmpdir, then the cloned repo's `.agents/skills/<n>/` and `.agents/mcps/<n>.json` are copied into the local project's `.agents/` (the tmpdir is cleaned up afterward). Same-name conflicts are skipped with a warning unless `--force`. After materialization, the install pipeline runs against the local project as if you'd passed `--repo .`.

**Local refs** are read directly from the source path — no copy step. Use `cp -R` first if you want a local copy in your project's `.agents/`.

### 2. Cloned a repo with `.agents/`

```bash
npx @latentevals/agent-setup                  # link to this project (project scope)
npx @latentevals/agent-setup install --global # link globally for all projects on this machine
```

### 3. Cloned a repo with only `.claude/`

```bash
npx @latentevals/agent-setup
```

Same command. `agent-setup` falls back to `.claude/skills/` and `.mcp.json` as the source-of-truth when `.agents/` isn't present, then writes equivalent configs for Cursor, Codex, Gemini, OpenCode.

Source-fallback priority in v0.1: `.agents/` → `.claude/` (with `.mcp.json`). Other tool fallbacks (`.cursor/`, `.codex/`, `.gemini/`, `.opencode/`) are deferred to v0.2 — the cross-tool round-trip story for those formats is lossier and warrants per-format adapters. First-match-wins applies.

---

## Commands

Three verbs, one mental model.

| Command | What it does |
| --- | --- |
| `agent-setup` | Alias for `install` |
| `agent-setup install` | Read source (`--repo` or default `.`), copy into `.agents/` if remote, link into detected agents |
| `agent-setup uninstall <name>` | Delete `.agents/skills/<name>/` and `.agents/mcps/<name>.json` from the source, then run install so the orphan-sweep clears per-tool entries |
| `agent-setup uninstall --all` | Reconcile against an empty canonical so the orphan-sweep removes everything the lockfile owns; `.agents/` itself is untouched |
| `agent-setup import` | Scan each harness's skill directory (`.claude/skills/`, `.cursor/skills/`, `.gemini/skills/`, `.codex/skills/`, `.opencode/skills/`) and copy SKILL.md skills into `.agents/skills/`. Run `install` after to propagate to the other tools. |

### `import` in detail

`import` is the inverse of `install`: it pulls skills *out of* per-tool dirs *into* the canonical `.agents/skills/`. Useful when you already have skills in a single harness and want them everywhere.

```bash
# Scan all five harnesses at project scope, copy non-conflicting skills
npx @latentevals/agent-setup import

# Only look at one harness
npx @latentevals/agent-setup import --from cursor

# Scan global locations (~/.claude/skills/, ~/.cursor/skills/, …)
npx @latentevals/agent-setup import --global

# Preview without writing
npx @latentevals/agent-setup import --dry-run
```

Decision logic per skill name found:

- **Found in one source, not yet in `.agents/`** → copy
- **Found in multiple sources with identical content** → copy once, note all sources
- **Found in multiple sources with differing content** → skip with conflict message; re-run with `--from <tool>` to disambiguate
- **Already in `.agents/`, source matches** → silent no-op
- **Already in `.agents/`, source differs** → skip unless `--force`
- **Source is a symlink resolving into `.agents/skills/`** (e.g., one we created during a previous `install`) → silent no-op

`import` never writes to per-tool config or the lockfile. After running `import`, run `install` to propagate the imported skills out to the other harnesses.

### Common flags

| Flag | Default | Purpose |
| --- | --- | --- |
| `--repo <source>` | `.` | source for `install` (local path or remote URL) |
| `--type=skill\|mcp` | both | narrow to one type [`install`/`uninstall`] |
| `--from=<tool>` | (all) | limit `import` scan to one harness (`claude\|codex\|cursor\|gemini\|opencode`) |
| `--project` | (default) | scope: read/write project paths |
| `--global` | | scope: read/write user-home paths (mutually exclusive with `--project`) |
| `--tool=claude,codex,…` | all detected | limit which adapters `install` writes |
| `--dry-run` | | preview without writing |
| `--force` | | bypass marker checks (`install`); overwrite existing `.agents/skills/<name>/` and resolve cross-source conflicts (`import`) |
| `--yes` / `-y` | | skip prompts; required when stdin is not a TTY |
| `--version` / `-v` | | print version |
| `--help` / `-h` | | print help |

---

## File formats

### `.agents/skills/<name>/SKILL.md`

Standard skill markdown — same format Claude Code, Codex, Gemini, OpenCode, and Cursor have all converged on:

```markdown
---
name: my-skill
description: One sentence describing when this skill applies.
---

# Body

Markdown content. Sibling files in the same directory can be referenced.
```

**Required frontmatter:** `name` (matches dir name, kebab-case), `description`.
**Optional:** `license`, `paths` (glob array — auto-trigger), `disable-model-invocation`.
**Optional registry metadata** (ignored by the linker, used by future discovery): `tags`, `homepage`, `repository`.

### `.agents/mcps/<name>.json`

One file per MCP server. Filename (without `.json`) must match the `name` field. **Strict JSON** — no comments or trailing commas.

HTTP server with bearer-token auth:

```json
{
  "name": "neon",
  "description": "Neon Postgres MCP server",
  "url": "https://mcp.neon.tech/sse",
  "auth": "bearer",
  "bearerEnvVar": "NEON_API_KEY",
  "targets": ["claude", "codex"],
  "tags": ["database", "postgres"],
  "homepage": "https://neon.tech",
  "repository": "https://github.com/neondatabase/mcp-server-neon",
  "license": "MIT"
}
```

Stdio server with environment passthrough:

```json
{
  "name": "local-tool",
  "command": "npx",
  "args": ["@example/some-mcp@latest"],
  "env": { "EXAMPLE_FLAG": "1" }
}
```

**Fields:**

- **Transport** — exactly one of: stdio (`command` + optional `args`) or HTTP (`url`). Mutually exclusive — the schema enforces it.
- **`auth`** — `"none"` (default), `"bearer"`, or `"oauth"`. Bearer auth is only meaningful on HTTP transports (the linker only emits `Authorization` headers for HTTP).
- **`bearerEnvVar`** — env-var name to read the bearer token from (required when `auth: "bearer"`). Inline secrets are rejected by policy.
- **Transport-specific (optional)** — `env: { KEY: "value" }` for stdio; `headers: { … }` for HTTP. The schema rejects each on the wrong transport.
- **`targets`** (optional) — whitelist of adapter names (`claude`, `codex`, `cursor`, `gemini`, `opencode`) this server applies to.
- **Registry-friendly metadata** (optional, ignored by the linker, used by future discovery) — `tags`, `homepage`, `repository`, `license`.

**Server-name rules:** lowercase ASCII, digits, hyphens. No underscores (Gemini's parser splits on `_`). 1–64 chars. Filename, `name` field, and dir entry must agree.

#### Legacy single-file format: `.agents/mcp.json`

Older repos predate the per-file layout and declare every server inline under a top-level `servers` map keyed by name. `agent-setup` reads this format too — there's no migration required.

```json
{
  "$schema": "./mcp.schema.json",
  "servers": {
    "shadcn": {
      "description": "shadcn registry",
      "command": "npx",
      "args": ["shadcn@latest", "mcp"]
    },
    "neon": {
      "url": "https://mcp.neon.tech/sse",
      "auth": "bearer",
      "bearerEnvVar": "NEON_API_KEY"
    }
  }
}
```

The map key IS the server name — entries omit a `name` field. All other fields match `.agents/mcps/<name>.json` exactly.

Both layouts may coexist. If the same server name appears in both `.agents/mcps/<name>.json` and `.agents/mcp.json`, the directory entry wins and `agent-setup` prints a one-line warning to stderr. Recommendation: pick one layout per project. Use the directory layout for new projects.

**Auth model:**

- `none` (default) — no credential
- `bearer` — linker emits the right env-var-based header per tool's syntax. Inline secrets are rejected.
- `oauth` — linker emits OAuth-discovery-friendly config. The user runs each tool's first-time login command (see below).

### `AGENTS.md`

Plain markdown at the project root. Codex, Cursor, Gemini, OpenCode read it natively. Claude Code reads `CLAUDE.md`, so the linker generates a one-line `CLAUDE.md` containing `@AGENTS.md` (Anthropic's [official cross-tool pattern](https://code.claude.com/docs/en/memory#agents-md)).

---

## Scopes

Two scopes. (`local` — per-user-per-project, gitignored — is intentionally **not** in v0.1; only Claude and OpenCode have a native concept and the cross-tool story is muddy.)

| Scope     | Flag                  | Source                                  | Per-tool destination |
| --------- | --------------------- | --------------------------------------- | -------------------- |
| `project` | `--project` (default) | `./.agents/` (or `--repo`)              | project paths (`.claude/skills/`, `.mcp.json`, `.codex/config.toml`, `.cursor/mcp.json`, `.gemini/settings.json`, `opencode.json`) |
| `global`  | `--global`            | `./.agents/` (or `--repo`) — same loader, different write target | home paths (`~/.claude/skills/`, `~/.claude.json`, `~/.codex/config.toml`, `~/.cursor/mcp.json`, `~/.gemini/settings.json`, `~/.config/opencode/opencode.json`) |

Project scope is for team-shared setup committed to source control. Global scope is for personal additions that follow the user across all projects on their machine.

---

## What it writes

Per detected agent. `.agents/` is the committed source of truth. The linker does **not** manage `.gitignore` — different outputs follow different conventions: `.mcp.json` and `opencode.json` are conventionally committed (they're meant to be team-shared); `.claude/skills/<n>` symlinks and the `CLAUDE.md` import stub are typically gitignored as generated artifacts. Decide per project.

| Tool      | Skills                                                          | MCP                          | Instructions                          |
| --------- | --------------------------------------------------------------- | ---------------------------- | ------------------------------------- |
| Claude    | `.claude/skills/<n>` per-skill symlinks → `.agents/skills/<n>`  | `.mcp.json`                  | `CLAUDE.md` with `@AGENTS.md` import  |
| Codex     | (native; no output)                                             | `.codex/config.toml`         | (native `AGENTS.md`)                  |
| Gemini    | (native; no output) + `context.fileName` → `AGENTS.md`          | `.gemini/settings.json`      | (native via `context.fileName`)       |
| Cursor    | (native v2.4+; no output)                                       | `.cursor/mcp.json`           | (native `AGENTS.md`)                  |
| OpenCode  | (native; no output)                                             | `opencode.json` `mcp` block  | (native `AGENTS.md`)                  |

---

## Agent detection

A tool is "installed" if its config directory exists. Pure `existsSync` checks, no PATH probing.

| Tool      | Project signal                | User signal                                              |
| --------- | ----------------------------- | -------------------------------------------------------- |
| Claude    | `.claude/` or `CLAUDE.md`     | `$CLAUDE_CONFIG_DIR` or `~/.claude/`                     |
| Codex     | `.codex/`                     | `$CODEX_HOME` or `~/.codex/`                             |
| Cursor    | `.cursor/`                    | `~/.cursor/`                                             |
| Gemini    | `.gemini/`                    | `~/.gemini/`                                             |
| OpenCode  | `.opencode/`                  | `$XDG_CONFIG_HOME/opencode/` or `~/.config/opencode/`    |

Detection seeds the multi-select default; the user can override via `--tool=` or by toggling in the UI.

---

## How it handles the messy parts

### Auth env-var translation

Every agent uses a different syntax for env-var references. You write `"bearerEnvVar": "MY_TOKEN"` once; each adapter translates:

| Tool     | Emitted form                                                          |
| -------- | --------------------------------------------------------------------- |
| Claude   | `"headers": { "Authorization": "Bearer ${MY_TOKEN}" }`                |
| Cursor   | `"headers": { "Authorization": "Bearer ${env:MY_TOKEN}" }`            |
| Gemini   | `"headers": { "Authorization": "Bearer ${MY_TOKEN}" }`                |
| OpenCode | `"headers": { "Authorization": "Bearer {env:MY_TOKEN}" }` (no `$`!)   |
| Codex    | `bearer_token_env_var = "MY_TOKEN"` (TOML; env-var **name** as string) |

### OAuth

For HTTP MCPs with `auth: oauth`, the linker writes config + prints the per-tool first-time login command. It never drives the OAuth flow itself.

| Tool     | First-time login                       |
| -------- | -------------------------------------- |
| Claude   | `/mcp` inside Claude Code              |
| Codex    | `codex mcp login <name>`               |
| Gemini   | `/mcp auth <name>` inside Gemini CLI   |
| OpenCode | `opencode mcp auth <name>`             |
| Cursor   | (auto on first server use)             |

### Lockfile-based idempotency

Shared config files (`.cursor/mcp.json`, `~/.claude.json`, `.codex/config.toml`, etc.) mix the linker's entries with hand-added ones. A lockfile per scope tracks what `agent-setup` owns:

- **Project scope:** `.agents/.lock.json` (committed)
- **Global scope:** `~/.agents/.lock.json`

On every run, the linker:

1. Reads the lockfile.
2. Removes owned entries no longer in `.agents/`.
3. Writes/updates owned entries currently in `.agents/`.
4. Leaves anything not in the lockfile strictly alone.

Hand-add an MCP server to `.cursor/mcp.json` and it survives re-links untouched.

### Hand-written files

A real `CLAUDE.md` you wrote yourself is preserved. Whole-file generated outputs (the `CLAUDE.md` import stub, brand-new config files) carry a `# Generated by agent-setup` marker on the first line. The linker refuses to overwrite a managed-path file lacking the marker without `--force`.

### Symlinks vs real dirs

A real directory at `.claude/skills/foo/` (a tool-only skill) is preserved across re-links. Only existing symlinks pointing into `.agents/skills/` are replaced. Orphan symlinks (pointing at a removed `.agents/` skill) are swept.

---

## Per-tool reference

Capability matrix across the v0.1 harnesses. "linker" means the harness doesn't read the convention natively; `agent-setup` bridges the gap.

|                       | Claude Code            | Codex                          | Cursor                  | Gemini CLI                       | OpenCode                                  |
| --------------------- | ---------------------- | ------------------------------ | ----------------------- | -------------------------------- | ----------------------------------------- |
| Reads `.agents/skills/` | linker (symlink)     | native                         | native (v2.4+)          | native                           | native                                    |
| Reads `AGENTS.md`     | linker (`@` import)    | native                         | native                  | native (via `context.fileName`)  | native                                    |
| MCP format            | JSON                   | TOML                           | JSON                    | JSON                             | JSON                                      |
| MCP project file      | `.mcp.json`            | `.codex/config.toml`           | `.cursor/mcp.json`      | `.gemini/settings.json`          | `opencode.json`                           |
| MCP global file       | `~/.claude.json`       | `~/.codex/config.toml`         | `~/.cursor/mcp.json`    | `~/.gemini/settings.json`        | `~/.config/opencode/opencode.json`        |
| Env-var syntax        | `${VAR}`               | `bearer_token_env_var = "VAR"` | `${env:VAR}`            | `${VAR}` / `$VAR`                | `{env:VAR}`                               |
| OAuth login           | `/mcp` in CC           | `codex mcp login <name>`       | auto on first use       | `/mcp auth <name>`               | auto (DCR) or `opencode mcp auth <name>`  |
| Project trust gate    | —                      | yes (must run `codex` first)   | —                       | —                                | —                                         |

The detail and gotchas behind each row:

### Claude Code

- **MCP scopes:** `.mcp.json` (project, designed to be committed — first-use approval prompt). `~/.claude.json` (global).
- **Skills:** `.claude/skills/` (project), `~/.claude/skills/` (global). Honors `$CLAUDE_CONFIG_DIR`.
- **Env interpolation:** `${VAR}` and `${VAR:-default}` (recent versions).
- **Enterprise:** managed `managed-mcp.json` at system paths takes exclusive control; `allowedMcpServers`/`deniedMcpServers` filter further.

### Codex

- **MCP scopes:** `.codex/config.toml` (project, **only loaded for trusted projects** — you must run `codex` once in the dir and explicitly trust it). `~/.codex/config.toml` (user/global). Honors `$CODEX_HOME`.
- **Skills:** `.agents/skills/` (native).
- **Env interpolation:** `bearer_token_env_var = "VAR_NAME"` — the literal env-var **name** as a string, not `${...}` interpolation. Arbitrary headers via `env_http_headers = { "X-API-Key" = "VAR_NAME" }`.
- **OAuth:** callback port is global (`mcp_oauth_callback_port`), per-server `scopes` controls scopes requested.
- **Format:** TOML, only one of the five.

### Cursor

- **MCP scopes:** `.cursor/mcp.json` (project), `~/.cursor/mcp.json` (user). No documented `mcp.local.json`; convention is gitignore + circulate `.cursor/mcp.example.json` if secrets are involved.
- **Skills:** `.agents/skills/` (native, v2.4+).
- **Env interpolation:** `${env:VAR}` — different from Claude's `${VAR}`. Easy to get wrong when porting.
- **OAuth:** automatic on first server use; static client creds via fixed callback `cursor://anysphere.cursor-mcp/oauth/callback`.

### Gemini CLI

- **MCP scopes:** `.gemini/settings.json` (workspace), `~/.gemini/settings.json` (user). Honors `.env` files for env-var substitution.
- **Skills:** `.agents/skills/` (native).
- **Env interpolation:** `$VAR` / `${VAR}` (also `%VAR%` on Windows). Undefined vars expand to empty string.
- **Precedence:** **System overrides → Workspace → User → System defaults** — workspace beats user, opposite of typical "user wins" conventions.
- **Two HTTP transports:** `httpUrl` (streamable HTTP) vs `url` (SSE).
- **Special providers:** `google_credentials` (ADC), `service_account_impersonation` (GCP SAs) — useful for enterprise.

### OpenCode

- **MCP scopes:** `opencode.json` / `opencode.jsonc` (project). `~/.config/opencode/opencode.json` (user). Most layered precedence stack of the five (8 layers including remote `.well-known/opencode` for org defaults, `OPENCODE_CONFIG`/`OPENCODE_CONFIG_CONTENT` env-var overrides, and macOS MDM).
- **Skills:** `.agents/skills/` (native).
- **Env interpolation:** `{env:VAR}` — note braces, no `$`. Different from every other tool.
- **Schema:** `"type": "local"` (stdio) vs `"type": "remote"` (HTTP). Field names are `command` (array), `environment` (not `env`), `headers`.
- **OAuth:** auto via Dynamic Client Registration (RFC 7591); manual via `opencode mcp auth`. Tokens at `~/.local/share/opencode/mcp-auth.json`.

---

## Emitter contract (internal)

In v0.1 the five emitters are internal modules; there's no public adapter API yet (deferred to v0.2 once the internal shape stabilizes). Each emitter is a pure function from canonical input to a list of `DesiredChange` records, plus an optional detection probe. The reconciler is the only thing that touches disk.

```ts
type DesiredChange =
  | { kind: "json-entry"; path: string; pointer: string; value: unknown; ownerKey: string }
  | { kind: "toml-entry"; path: string; pointer: string; value: unknown; ownerKey: string }
  | { kind: "text-file";  path: string; content: string; marker: string }
  | { kind: "symlink";    link: string; target: string };

type EmitInput = {
  servers: Server[];        // post-`targets` filter pre-applied by the runner
  skills: Skill[];
  agentsMd: string | null;
  scope: "project" | "global";
  root: string;             // cwd for project, $HOME for global
};

type Emitter = {
  name: "claude" | "codex" | "cursor" | "gemini" | "opencode";
  detect?(input: { root: string; scope: Scope }): Promise<{ installed: boolean }>;
  emit(input: EmitInput): DesiredChange[];
};
```

`json-entry` / `toml-entry` carry an explicit `ownerKey` (e.g. `"mcpServers.neon"` or `"mcp_servers.neon"`) so the reconciler records ownership in the lockfile and knows what to remove on uninstall — emitters never touch the lockfile directly. Removals are computed by diffing prior-owned vs current-owned; there are no explicit `remove-*-keys` actions.

`text-file` writes always go through a marker check: if the destination exists and its first line doesn't contain the declared `marker`, the reconciler refuses unless `--force`. There's no `ifMissing` flag — the marker semantics handle both the "create" and "update" cases.

`symlink` writes refuse when the destination is a real file or real directory; existing symlinks (whether pointing at our target or a different one) are replaced. Orphan symlinks (in the lockfile but not in the new emit set) are swept by the reconciler.

Source files: `src/types.ts` (types), `src/emitters/*.ts` (the five emitters), `src/reconcile.ts` (the safety-enforcing writer).

---

## What it isn't

- **Not a runtime.** Doesn't run MCP servers or invoke skills. Only writes config.
- **Not installing the agents.** Bring your own `claude`, `codex`, `cursor`, etc.
- **Not driving OAuth.** Writes config; you run the per-tool login command.
- **Not validating content.** Doesn't check skill quality or MCP server availability.
- **Not opinionated about discovery.** No registry in v0.1 — `--name <slug>` is deferred until something exists to look up.

---

## Open questions

1. **Versioning the standard.** `$schema` URL should be versioned. v0 → v1 migration story?
2. **MCP servers shipped by the agent itself.** Some tools bundle MCPs (OpenCode's built-ins, Claude Code's). How does the schema mark "only emit if not already present"?
3. **Multiple project layers.** Some tools walk from cwd to git root and concatenate. Should `agent-setup` produce per-subtree configs, or only at the repo root?
4. **Per-tool instruction overrides.** Is one `AGENTS.md` enough, or should the spec handle a `.agents/instructions/<tool>.md` directory for tool-scoped guidance?
5. **Distribution.** Single npm package, standalone binary via `npx`/`pkgx`, both?

---

## Prior art

- **`.agents/skills/`** — convention emerging across Codex, Gemini CLI, Cursor v2.4+, OpenCode. SKILL.md format originated with Claude Code Agent Skills.
- **`AGENTS.md`** — cross-tool project-instructions standard adopted by OpenAI, Anthropic, Google, Cursor, OpenCode, Aider, Zed, GitHub Copilot, and others. Claude Code currently reads `CLAUDE.md`; the official workaround is a one-line `@AGENTS.md` import.
- **[skills.sh](https://skills.sh) / `npx skills`** — solves skill discovery and per-agent install. `agent-setup` covers the same ground for skills, plus MCP servers, plus project instructions, with a project-as-source-of-truth model.
- **[`add-mcp`](https://github.com/neondatabase/add-mcp)** — auto-detects MCP clients and writes config for each. Solves "one URL → many configs" but doesn't handle skills, isn't bidirectional, and assumes you want every detected agent.
- **EditorConfig**, **devcontainer.json** — precedents for "one declarative file, many tool integrations."

---

## Reference implementation

v0.1.0-alpha is implemented in `src/` and ships in this package — TypeScript ESM, Node 18.17+, distributed via `npx`. Runtime deps: `@clack/prompts` (interactive UI), `zod` (schemas), `smol-toml` (codex config), `gray-matter` (SKILL.md frontmatter). Git is shelled out via `child_process.execFile` for `--repo owner/repo` shallow clones — no `simple-git` dep.

Architecture map:

- `src/load-source.ts` — canonical loader (`.agents/` primary + `.claude/`-fallback)
- `src/schema.ts` — zod schemas for skills + servers
- `src/emitters/` — five pure emitter functions (claude, codex, cursor, gemini, opencode)
- `src/reconcile.ts` — ownership-aware writer (marker checks, real-dir refusals, orphan sweep)
- `src/lockfile.ts` — read/write `.agents/.lock.json`
- `src/install.ts` / `src/uninstall.ts` — orchestrators
- `src/ui/flow.ts` + `src/ui/prompts.ts` — interactive flow (TTY only)
- `src/cli.ts` — argv parser + dispatch
- `src/repo.ts` + `src/git.ts` — `--repo` resolution and remote materialization

Test suite: `vitest run` (tested on Node 20 + 22 in CI; see `.github/workflows/`).
