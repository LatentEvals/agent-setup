// Codex emitter — TOML at .codex/config.toml (project) or
// ~/.codex/config.toml (global), key mcp_servers.<name>.
// No skills/AGENTS output: codex reads .agents/skills/ and AGENTS.md natively.

import { homedir } from "node:os";
import path from "node:path";

import { detectCodex } from "../detect.js";
import type { DesiredChange, EmitInput, Emitter } from "../types.js";
import { codexAuth, isHttpTransport, isStdioTransport } from "./shared.js";
import type { Server } from "../schema.js";

function buildEntry(server: Server): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (isStdioTransport(server)) {
    out["command"] = server.command;
    if (server.args) out["args"] = server.args;
    if (server.env) out["env"] = server.env;
  } else if (isHttpTransport(server)) {
    out["url"] = server.url;
    const auth = codexAuth(server);
    if (auth && "bearer_token_env_var" in auth) {
      out["bearer_token_env_var"] = auth.bearer_token_env_var;
    }
    // Pass-through static headers (no env-var translation — codex uses
    // env_http_headers for that, and we only emit it when callers set
    // bearerEnvVar. v0.1 doesn't synthesize per-header env vars.)
    if (server.headers && Object.keys(server.headers).length > 0) {
      out["headers"] = server.headers;
    }
  }
  return out;
}

function emit(input: EmitInput): DesiredChange[] {
  const changes: DesiredChange[] = [];
  const tomlFile =
    input.scope === "project"
      ? path.join(input.root, ".codex", "config.toml")
      : path.join(homedir(), ".codex", "config.toml");

  for (const server of input.servers) {
    changes.push({
      kind: "toml-entry",
      path: tomlFile,
      pointer: `mcp_servers.${server.name}`,
      value: buildEntry(server),
      ownerKey: `mcp_servers.${server.name}`,
    });
  }
  return changes;
}

export const codexEmitter: Emitter = {
  name: "codex",
  detect: detectCodex,
  emit,
};
