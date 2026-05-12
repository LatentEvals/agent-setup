// Shared EmitInput used by every emitter snapshot test, so the goldens
// reflect the same canonical input. We deliberately use a fixed `root`
// of "/proj" (no real filesystem; emitters are pure) — paths in the
// goldens will be relative to this synthetic root.

import type { EmitInput } from "../../src/types.js";
import { ServerSchema, SkillSchema } from "../../src/schema.js";

export function makeInput(
  scope: "project" | "global",
  rootOverride?: string,
): EmitInput {
  const root = rootOverride ?? (scope === "project" ? "/proj" : "/home/u");

  const skills = [
    SkillSchema.parse({
      name: "hello",
      description: "Say hello.",
      body: "# Hello\n",
      dir: `${root}/.agents/skills/hello`,
    }),
    SkillSchema.parse({
      name: "world",
      description: "Say world.",
      body: "# World\n",
      dir: `${root}/.agents/skills/world`,
    }),
  ];

  const servers = [
    // bearer http
    ServerSchema.parse({
      name: "neon",
      description: "Neon Postgres MCP",
      url: "https://mcp.neon.tech/sse",
      auth: "bearer",
      bearerEnvVar: "NEON_API_KEY",
    }),
    // oauth http
    ServerSchema.parse({
      name: "posthog",
      description: "PostHog MCP",
      url: "https://mcp.posthog.com/sse",
      auth: "oauth",
    }),
  ];

  return {
    skills,
    servers,
    agentsMd: "# AGENTS\n\nBe helpful.\n",
    scope,
    root,
  };
}
