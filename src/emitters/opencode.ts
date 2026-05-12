// OpenCode emitter — JSON at opencode.json (project) or
// ~/.config/opencode/opencode.json (global), key mcp.<name>.
//
// OpenCode's schema is unique:
//   { "type": "local",  "command": ["bin", "arg", ...], "environment": {...} }
//   { "type": "remote", "url": "...",                   "headers": {...}     }
// Note: `command` is an ARRAY (head + args together), `environment` not `env`.
//
// Auth syntax: `{env:VAR}` (no $).

import path from "node:path";

import { detectOpencode } from "../detect.js";
import type { DesiredChange, EmitInput, Emitter } from "../types.js";
import {
  bearerHeaderBraceEnv,
  isHttpTransport,
  isStdioTransport,
} from "./shared.js";
import type { Server } from "../schema.js";

function buildEntry(server: Server): Record<string, unknown> {
  if (isStdioTransport(server)) {
    const cmdArr: string[] = [server.command as string, ...(server.args ?? [])];
    const out: Record<string, unknown> = {
      type: "local",
      command: cmdArr,
    };
    if (server.env) out["environment"] = server.env;
    return out;
  }
  if (isHttpTransport(server)) {
    const headers: Record<string, string> = { ...(server.headers ?? {}) };
    const auth = bearerHeaderBraceEnv(server);
    if (auth) Object.assign(headers, auth);
    const out: Record<string, unknown> = {
      type: "remote",
      url: server.url,
    };
    if (Object.keys(headers).length > 0) out["headers"] = headers;
    return out;
  }
  return {};
}

function xdgConfigHome(root: string): string {
  const xdg = process.env["XDG_CONFIG_HOME"];
  return xdg && xdg.length > 0 ? xdg : path.join(root, ".config");
}

function emit(input: EmitInput): DesiredChange[] {
  const changes: DesiredChange[] = [];
  const file =
    input.scope === "project"
      ? path.join(input.root, "opencode.json")
      : path.join(xdgConfigHome(input.root), "opencode", "opencode.json");

  for (const server of input.servers) {
    changes.push({
      kind: "json-entry",
      path: file,
      pointer: `mcp.${server.name}`,
      value: buildEntry(server),
      ownerKey: `mcp.${server.name}`,
    });
  }
  return changes;
}

export const opencodeEmitter: Emitter = {
  name: "opencode",
  detect: detectOpencode,
  emit,
};
