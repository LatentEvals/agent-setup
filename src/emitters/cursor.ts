// Cursor emitter — JSON at .cursor/mcp.json (project) or
// ~/.cursor/mcp.json (global), key mcpServers.<name>.
// Skills are native (v2.4+). No AGENTS output (native).

import path from "node:path";

import { detectCursor } from "../detect.js";
import type { DesiredChange, EmitInput, Emitter } from "../types.js";
import {
  bearerHeaderDollarEnv,
  isHttpTransport,
  isStdioTransport,
} from "./shared.js";
import type { Server } from "../schema.js";

function buildEntry(server: Server): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (isStdioTransport(server)) {
    out["command"] = server.command;
    if (server.args) out["args"] = server.args;
    if (server.env) out["env"] = server.env;
  } else if (isHttpTransport(server)) {
    out["url"] = server.url;
    const headers: Record<string, string> = { ...(server.headers ?? {}) };
    const auth = bearerHeaderDollarEnv(server);
    if (auth) Object.assign(headers, auth);
    if (Object.keys(headers).length > 0) out["headers"] = headers;
  }
  return out;
}

function emit(input: EmitInput): DesiredChange[] {
  const changes: DesiredChange[] = [];
  const file = path.join(input.root, ".cursor", "mcp.json");

  for (const server of input.servers) {
    changes.push({
      kind: "json-entry",
      path: file,
      pointer: `mcpServers.${server.name}`,
      value: buildEntry(server),
      ownerKey: `mcpServers.${server.name}`,
    });
  }
  return changes;
}

export const cursorEmitter: Emitter = {
  name: "cursor",
  detect: detectCursor,
  emit,
};
