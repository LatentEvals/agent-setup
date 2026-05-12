import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  discoverSource,
  loadFromAgents,
  loadFromClaudeFallback,
} from "../src/load-source.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, "fixtures", "sources");
const AGENTS_ROOT = path.join(FIXTURES, "agents");
const AGENTS_LEGACY_ROOT = path.join(FIXTURES, "agents-legacy");
const CLAUDE_ROOT = path.join(FIXTURES, "claude");

describe("loadFromAgents", () => {
  test("loads skills, mcps, and AGENTS.md from .agents/", async () => {
    const out = await loadFromAgents(AGENTS_ROOT);
    expect(out.skills.map((s) => s.name)).toEqual(["hello", "world"]);
    expect(out.servers.map((s) => s.name)).toEqual(["local-tool", "neon"]);

    const neon = out.servers.find((s) => s.name === "neon");
    expect(neon?.auth).toBe("bearer");
    expect(neon?.bearerEnvVar).toBe("NEON_API_KEY");

    const local = out.servers.find((s) => s.name === "local-tool");
    expect(local?.command).toBe("npx");
    expect(local?.auth).toBe("none");

    expect(out.agentsMd).toMatch(/Be helpful/);
  });

  test("loads body content for skills", async () => {
    const out = await loadFromAgents(AGENTS_ROOT);
    const hello = out.skills.find((s) => s.name === "hello");
    expect(hello?.body).toMatch(/# Hello/);
  });
});

describe("loadFromAgents — legacy `.agents/mcp.json`", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stderrCalls: string[];

  beforeEach(() => {
    stderrCalls = [];
    stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: unknown) => {
        stderrCalls.push(typeof chunk === "string" ? chunk : String(chunk));
        return true;
      });
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  test("loads servers from a single-file `.agents/mcp.json` with key-as-name", async () => {
    const out = await loadFromAgents(AGENTS_LEGACY_ROOT);
    expect(out.servers.map((s) => s.name)).toEqual([
      "create-webapp",
      "shadcn",
    ]);

    const shadcn = out.servers.find((s) => s.name === "shadcn");
    expect(shadcn?.command).toBe("npx");
    expect(shadcn?.args).toEqual(["shadcn@latest", "mcp"]);

    const cw = out.servers.find((s) => s.name === "create-webapp");
    expect(cw?.url).toBe("http://localhost:3000/api/mcp");
    expect(cw?.auth).toBe("oauth");
  });

  test("merges directory entries with legacy file entries (no overlap)", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "as-merge-"));
    try {
      const agentsDir = path.join(tmp, ".agents");
      await fs.mkdir(path.join(agentsDir, "mcps"), { recursive: true });
      await fs.writeFile(
        path.join(agentsDir, "mcps", "foo.json"),
        JSON.stringify({ name: "foo", command: "foo-bin" }),
      );
      await fs.writeFile(
        path.join(agentsDir, "mcp.json"),
        JSON.stringify({
          servers: {
            bar: { url: "https://bar.example.com/mcp" },
          },
        }),
      );

      const out = await loadFromAgents(tmp);
      expect(out.servers.map((s) => s.name)).toEqual(["bar", "foo"]);
      expect(stderrCalls.join("")).toBe("");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  test("on name conflict the directory wins and a stderr warning is emitted", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "as-conflict-"));
    try {
      const agentsDir = path.join(tmp, ".agents");
      await fs.mkdir(path.join(agentsDir, "mcps"), { recursive: true });
      await fs.writeFile(
        path.join(agentsDir, "mcps", "foo.json"),
        JSON.stringify({ name: "foo", command: "from-dir" }),
      );
      await fs.writeFile(
        path.join(agentsDir, "mcp.json"),
        JSON.stringify({
          servers: {
            foo: { command: "from-legacy" },
          },
        }),
      );

      const out = await loadFromAgents(tmp);
      expect(out.servers).toHaveLength(1);
      const foo = out.servers[0];
      expect(foo?.name).toBe("foo");
      expect(foo?.command).toBe("from-dir");

      const stderr = stderrCalls.join("");
      expect(stderr).toMatch(/'\.agents\/mcp\.json' has server 'foo'/);
      expect(stderr).toMatch(/using the directory version/);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  test("legacy file with invalid top-level shape surfaces a schema error with the file path", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "as-bad-top-"));
    try {
      const agentsDir = path.join(tmp, ".agents");
      await fs.mkdir(agentsDir, { recursive: true });
      // `servers` is an array — must be an object map.
      await fs.writeFile(
        path.join(agentsDir, "mcp.json"),
        JSON.stringify({ servers: ["a", "b"] }),
      );

      await expect(loadFromAgents(tmp)).rejects.toThrow(
        /invalid legacy mcp file at .*\.agents\/mcp\.json/,
      );
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  test("legacy file with an invalid server entry surfaces file path AND server name", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "as-bad-srv-"));
    try {
      const agentsDir = path.join(tmp, ".agents");
      await fs.mkdir(agentsDir, { recursive: true });
      // Neither `command` nor `url` — schema must reject.
      await fs.writeFile(
        path.join(agentsDir, "mcp.json"),
        JSON.stringify({
          servers: {
            broken: { description: "no transport" },
          },
        }),
      );

      await expect(loadFromAgents(tmp)).rejects.toThrow(
        /invalid mcp server "broken" in .*\.agents\/mcp\.json/,
      );
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("loadFromClaudeFallback", () => {
  test("loads skills from .claude/skills/ and translates .mcp.json", async () => {
    const out = await loadFromClaudeFallback(CLAUDE_ROOT);
    expect(out.skills.map((s) => s.name)).toEqual(["legacy"]);
    expect(out.servers.map((s) => s.name)).toEqual(["local-tool", "neon"]);

    // The Authorization header should round-trip back to a bearerEnvVar.
    const neon = out.servers.find((s) => s.name === "neon");
    expect(neon?.auth).toBe("bearer");
    expect(neon?.bearerEnvVar).toBe("NEON_API_KEY");

    // Stdio entry preserves command/args/env.
    const local = out.servers.find((s) => s.name === "local-tool");
    expect(local?.command).toBe("npx");
    expect(local?.args).toEqual(["@example/some-mcp@latest"]);

    // Falls back to CLAUDE.md when AGENTS.md absent.
    expect(out.agentsMd).toMatch(/Hand-written/);
  });
});

describe("discoverSource", () => {
  test("prefers .agents/", async () => {
    const out = await discoverSource(AGENTS_ROOT);
    expect(out.sourcePath).toMatch(/\.agents$/);
    expect(out.canonical.skills.length).toBe(2);
  });

  test("falls back to .claude/", async () => {
    const out = await discoverSource(CLAUDE_ROOT);
    expect(out.sourcePath).toMatch(/\.claude$/);
    expect(out.canonical.skills.map((s) => s.name)).toEqual(["legacy"]);
  });

  test("throws when no source present", async () => {
    await expect(discoverSource(here)).rejects.toThrow(/no source found/);
  });
});
