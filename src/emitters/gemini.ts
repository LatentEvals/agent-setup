// Gemini emitter — JSON at .gemini/settings.json (project) or
// ~/.gemini/settings.json (global). MCP entries at mcpServers.<name>.
// Plus a separate json-entry for context.fileName: "AGENTS.md" — the
// reconciler is responsible for skipping this if the user already set
// it to a different value (the emitter is pure and always declares the
// desire). No skills emit.

import { homedir } from "node:os";
import path from "node:path";

import { detectGemini } from "../detect.js";
import type { DesiredChange, EmitInput, Emitter } from "../types.js";
import {
  bearerHeaderDollar,
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
    // Gemini distinguishes httpUrl (streamable HTTP) vs url (SSE).
    // We default to httpUrl since most modern MCPs use streamable HTTP;
    // override is a future-extension hook.
    out["httpUrl"] = server.url;
    const headers: Record<string, string> = { ...(server.headers ?? {}) };
    const auth = bearerHeaderDollar(server);
    if (auth) Object.assign(headers, auth);
    if (Object.keys(headers).length > 0) out["headers"] = headers;
  }
  return out;
}

function emit(input: EmitInput): DesiredChange[] {
  const changes: DesiredChange[] = [];
  const file =
    input.scope === "project"
      ? path.join(input.root, ".gemini", "settings.json")
      : path.join(homedir(), ".gemini", "settings.json");

  for (const server of input.servers) {
    changes.push({
      kind: "json-entry",
      path: file,
      pointer: `mcpServers.${server.name}`,
      value: buildEntry(server),
      ownerKey: `mcpServers.${server.name}`,
    });
  }

  // Nudge AGENTS.md as the context file. The reconciler skips this
  // emission if the value already matches (or — per spec — if the user
  // has set context.fileName to anything else).
  if (input.agentsMd !== null) {
    changes.push({
      kind: "json-entry",
      path: file,
      pointer: "context.fileName",
      value: "AGENTS.md",
      ownerKey: "context.fileName",
    });
  }

  return changes;
}

export const geminiEmitter: Emitter = {
  name: "gemini",
  detect: detectGemini,
  emit,
};
