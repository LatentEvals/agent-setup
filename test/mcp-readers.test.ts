// Unit tests for per-tool MCP entry readers.

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  readClaudeMcps,
  readCursorMcps,
  readGeminiMcps,
  readOpenCodeMcps,
  readCodexMcps,
} from "../src/mcp-readers.js";

let root: string;

async function write(p: string, body: string): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, body, "utf8");
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "mcp-readers-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("readClaudeMcps", () => {
  test("reads entries under mcpServers", async () => {
    const file = path.join(root, ".mcp.json");
    await write(
      file,
      JSON.stringify({
        mcpServers: {
          neon: { url: "https://mcp.neon.tech/sse" },
          local: { command: "npx", args: ["@x/y"] },
        },
      }),
    );
    const entries = await readClaudeMcps(file);
    expect(entries.map((e) => e.name)).toEqual(["local", "neon"]); // sorted
  });

  test("missing file returns []", async () => {
    const entries = await readClaudeMcps(path.join(root, "nope.json"));
    expect(entries).toEqual([]);
  });

  test("malformed JSON throws", async () => {
    const file = path.join(root, ".mcp.json");
    await write(file, "{ not json");
    await expect(readClaudeMcps(file)).rejects.toThrow(/parse JSON/);
  });
});

describe("readCursorMcps", () => {
  test("reads entries under mcpServers", async () => {
    const file = path.join(root, "mcp.json");
    await write(file, JSON.stringify({ mcpServers: { x: { url: "u" } } }));
    const entries = await readCursorMcps(file);
    expect(entries.map((e) => e.name)).toEqual(["x"]);
  });
});

describe("readGeminiMcps", () => {
  test("reads entries under mcpServers", async () => {
    const file = path.join(root, "settings.json");
    await write(
      file,
      JSON.stringify({ mcpServers: { g: { httpUrl: "https://g" } } }),
    );
    const entries = await readGeminiMcps(file);
    expect(entries.map((e) => e.name)).toEqual(["g"]);
  });
});

describe("readOpenCodeMcps", () => {
  test("reads entries under mcp", async () => {
    const file = path.join(root, "opencode.json");
    await write(
      file,
      JSON.stringify({
        mcp: { o: { type: "remote", url: "https://o" } },
      }),
    );
    const entries = await readOpenCodeMcps(file);
    expect(entries.map((e) => e.name)).toEqual(["o"]);
  });
});

describe("readCodexMcps", () => {
  test("reads tables under mcp_servers", async () => {
    const file = path.join(root, "config.toml");
    await write(
      file,
      `
[mcp_servers.neon]
url = "https://mcp.neon.tech/sse"
bearer_token_env_var = "NEON_API_KEY"

[mcp_servers.local]
command = "npx"
args = ["@x/y"]
`,
    );
    const entries = await readCodexMcps(file);
    expect(entries.map((e) => e.name)).toEqual(["local", "neon"]);
  });

  test("missing file returns []", async () => {
    const entries = await readCodexMcps(path.join(root, "nope.toml"));
    expect(entries).toEqual([]);
  });

  test("malformed TOML throws", async () => {
    const file = path.join(root, "config.toml");
    await write(file, "= invalid =");
    await expect(readCodexMcps(file)).rejects.toThrow(/parse TOML/);
  });
});
