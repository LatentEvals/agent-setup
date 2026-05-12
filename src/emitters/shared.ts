// Auth-syntax helpers, one per variant in the README's translation table.
// All return null when there's nothing to emit (no auth, or oauth — which
// is handled per-emitter, since the OAuth config shape differs per tool).

import type { Server } from "../schema.js";

// Claude / Gemini: ${VAR}
export function bearerHeaderDollar(
  server: Server,
): { Authorization: string } | null {
  if (server.auth !== "bearer" || !server.bearerEnvVar) return null;
  return { Authorization: `Bearer \${${server.bearerEnvVar}}` };
}

// Cursor: ${env:VAR}
export function bearerHeaderDollarEnv(
  server: Server,
): { Authorization: string } | null {
  if (server.auth !== "bearer" || !server.bearerEnvVar) return null;
  return { Authorization: `Bearer \${env:${server.bearerEnvVar}}` };
}

// OpenCode: {env:VAR} (no $)
export function bearerHeaderBraceEnv(
  server: Server,
): { Authorization: string } | null {
  if (server.auth !== "bearer" || !server.bearerEnvVar) return null;
  return { Authorization: `Bearer {env:${server.bearerEnvVar}}` };
}

// Codex: TOML name-string forms.
//
// For HTTP servers with bearer auth, codex wants
//   bearer_token_env_var = "VAR_NAME"
// For arbitrary headers via env-var name we'd use
//   env_http_headers = { "X-API-Key" = "VAR_NAME" }
// We only emit the bearer form here; the codex emitter assembles the
// surrounding TOML table.
export function codexAuth(
  server: Server,
):
  | { bearer_token_env_var: string }
  | { headers: Record<string, string> }
  | null {
  if (server.auth === "bearer" && server.bearerEnvVar) {
    return { bearer_token_env_var: server.bearerEnvVar };
  }
  return null;
}

// True if this server should emit a non-stdio (HTTP) entry.
export function isHttpTransport(server: Server): boolean {
  return typeof server.url === "string" && server.url.length > 0;
}

export function isStdioTransport(server: Server): boolean {
  return typeof server.command === "string" && server.command.length > 0;
}
