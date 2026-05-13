// Integration tests for runImport with MCPs.

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { runImport } from "../src/import.js";
import { runInstall } from "../src/install.js";

let root: string;
let homeDir: string;
let prevHome: string | undefined;
let prevCwd: string;
let prevXdg: string | undefined;

async function writeFile(p: string, body: string): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, body, "utf8");
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "agent-setup-import-mcp-"));
  homeDir = await fs.mkdtemp(path.join(tmpdir(), "agent-setup-import-mcp-home-"));
  prevHome = process.env["HOME"];
  process.env["HOME"] = homeDir;
  prevXdg = process.env["XDG_CONFIG_HOME"];
  delete process.env["XDG_CONFIG_HOME"];
  prevCwd = process.cwd();
  process.chdir(root);
});

afterEach(async () => {
  process.chdir(prevCwd);
  if (prevHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = prevHome;
  if (prevXdg === undefined) delete process.env["XDG_CONFIG_HOME"];
  else process.env["XDG_CONFIG_HOME"] = prevXdg;
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(homeDir, { recursive: true, force: true });
});

describe("runImport --type=mcp (single source)", () => {
  test("imports stdio + bearer-http from .cursor/mcp.json", async () => {
    await writeFile(
      path.join(root, ".cursor", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          neon: {
            url: "https://mcp.neon.tech/sse",
            headers: { Authorization: "Bearer ${env:NEON_API_KEY}" },
          },
          local: {
            command: "npx",
            args: ["@example/some-mcp@latest"],
          },
        },
      }),
    );
    const result = await runImport({
      cwd: root,
      scope: "project",
      type: "mcp",
      dryRun: false,
      force: false,
    });
    expect(result.imported.sort()).toEqual(["local", "neon"]);
    const neonText = await fs.readFile(
      path.join(root, ".agents", "mcps", "neon.json"),
      "utf8",
    );
    const neon = JSON.parse(neonText);
    expect(neon).toMatchObject({
      name: "neon",
      url: "https://mcp.neon.tech/sse",
      auth: "bearer",
      bearerEnvVar: "NEON_API_KEY",
    });
    expect(neon.headers).toBeUndefined();
    const localText = await fs.readFile(
      path.join(root, ".agents", "mcps", "local.json"),
      "utf8",
    );
    const local = JSON.parse(localText);
    expect(local).toMatchObject({
      name: "local",
      command: "npx",
      args: ["@example/some-mcp@latest"],
      auth: "none",
    });
  });

  test("round-trip: import from cursor → install → cursor's mcp.json comes back matching", async () => {
    const original = {
      mcpServers: {
        neon: {
          url: "https://mcp.neon.tech/sse",
          headers: { Authorization: "Bearer ${env:NEON_API_KEY}" },
        },
      },
    };
    await writeFile(
      path.join(root, ".cursor", "mcp.json"),
      JSON.stringify(original, null, 2) + "\n",
    );
    await runImport({
      cwd: root,
      scope: "project",
      type: "mcp",
      dryRun: false,
      force: false,
    });
    // Wipe cursor's file so install actually re-emits it.
    await fs.rm(path.join(root, ".cursor", "mcp.json"));
    await fs.mkdir(path.join(root, ".cursor"), { recursive: true });
    await runInstall({
      repo: ".",
      scope: "project",
      tool: ["cursor"],
      type: "mcp",
      dryRun: false,
      force: false,
      cwd: root,
    });
    const after = JSON.parse(
      await fs.readFile(path.join(root, ".cursor", "mcp.json"), "utf8"),
    );
    expect(after.mcpServers.neon.url).toBe("https://mcp.neon.tech/sse");
    expect(after.mcpServers.neon.headers.Authorization).toBe(
      "Bearer ${env:NEON_API_KEY}",
    );
  });
});

describe("runImport --type=mcp (multi-source)", () => {
  test("same canonical content from claude + cursor → imported once, both sources noted", async () => {
    await writeFile(
      path.join(root, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          neon: {
            url: "https://mcp.neon.tech/sse",
            headers: { Authorization: "Bearer ${NEON_API_KEY}" },
          },
        },
      }),
    );
    await writeFile(
      path.join(root, ".cursor", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          neon: {
            url: "https://mcp.neon.tech/sse",
            headers: { Authorization: "Bearer ${env:NEON_API_KEY}" },
          },
        },
      }),
    );
    const result = await runImport({
      cwd: root,
      scope: "project",
      type: "mcp",
      dryRun: false,
      force: false,
    });
    expect(result.imported).toEqual(["neon"]);
    const copy = result.actions.find((a) => a.kind === "copy");
    if (copy && copy.kind === "copy") {
      expect(copy.sources.sort()).toEqual(["claude", "cursor"]);
    }
  });

  test("differing URL → skip-conflict", async () => {
    await writeFile(
      path.join(root, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          neon: { url: "https://a.example" },
        },
      }),
    );
    await writeFile(
      path.join(root, ".cursor", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          neon: { url: "https://b.example" },
        },
      }),
    );
    const result = await runImport({
      cwd: root,
      scope: "project",
      type: "mcp",
      dryRun: false,
      force: false,
    });
    expect(result.imported).toEqual([]);
    expect(result.skipped).toEqual(["neon"]);
    const conflict = result.actions.find((a) => a.kind === "skip-conflict");
    expect(conflict).toBeDefined();
  });

  test("--from cursor resolves a conflict", async () => {
    await writeFile(
      path.join(root, ".mcp.json"),
      JSON.stringify({
        mcpServers: { neon: { url: "https://a.example" } },
      }),
    );
    await writeFile(
      path.join(root, ".cursor", "mcp.json"),
      JSON.stringify({
        mcpServers: { neon: { url: "https://b.example" } },
      }),
    );
    const result = await runImport({
      cwd: root,
      scope: "project",
      type: "mcp",
      from: "cursor",
      dryRun: false,
      force: false,
    });
    expect(result.imported).toEqual(["neon"]);
    const text = await fs.readFile(
      path.join(root, ".agents", "mcps", "neon.json"),
      "utf8",
    );
    expect(JSON.parse(text).url).toBe("https://b.example");
  });
});

describe("runImport --type=mcp (invalid)", () => {
  test("inline-secret bearer → skip-invalid, others still import", async () => {
    await writeFile(
      path.join(root, ".cursor", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          bad: {
            url: "https://x",
            headers: { Authorization: "Bearer literal-token-123" },
          },
          good: { command: "npx", args: ["@x/y"] },
        },
      }),
    );
    const result = await runImport({
      cwd: root,
      scope: "project",
      type: "mcp",
      dryRun: false,
      force: false,
    });
    expect(result.imported).toEqual(["good"]);
    expect(result.skipped).toEqual(["bad"]);
    const inv = result.actions.find((a) => a.kind === "skip-invalid");
    expect(inv).toBeDefined();
  });
});

describe("runImport --type=mcp (already canonical)", () => {
  test("existing .agents/mcps/<n>.json matches source → silent noop", async () => {
    const server = {
      name: "x",
      command: "npx",
      args: ["@a/b"],
      auth: "none" as const,
    };
    await writeFile(
      path.join(root, ".agents", "mcps", "x.json"),
      JSON.stringify(server, null, 2) + "\n",
    );
    await writeFile(
      path.join(root, ".cursor", "mcp.json"),
      JSON.stringify({
        mcpServers: { x: { command: "npx", args: ["@a/b"] } },
      }),
    );
    const result = await runImport({
      cwd: root,
      scope: "project",
      type: "mcp",
      dryRun: false,
      force: false,
    });
    expect(result.imported).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(
      result.actions.find((a) => a.kind === "noop-already-canonical"),
    ).toBeDefined();
  });

  test("existing canonical differs from source → skip-existing without --force", async () => {
    await writeFile(
      path.join(root, ".agents", "mcps", "x.json"),
      JSON.stringify(
        { name: "x", command: "old-binary", auth: "none" },
        null,
        2,
      ) + "\n",
    );
    await writeFile(
      path.join(root, ".cursor", "mcp.json"),
      JSON.stringify({
        mcpServers: { x: { command: "new-binary" } },
      }),
    );
    const result = await runImport({
      cwd: root,
      scope: "project",
      type: "mcp",
      dryRun: false,
      force: false,
    });
    expect(result.imported).toEqual([]);
    expect(result.skipped).toEqual(["x"]);
  });

  test("--force overwrites existing canonical", async () => {
    await writeFile(
      path.join(root, ".agents", "mcps", "x.json"),
      JSON.stringify(
        { name: "x", command: "old-binary", auth: "none" },
        null,
        2,
      ) + "\n",
    );
    await writeFile(
      path.join(root, ".cursor", "mcp.json"),
      JSON.stringify({
        mcpServers: { x: { command: "new-binary" } },
      }),
    );
    const result = await runImport({
      cwd: root,
      scope: "project",
      type: "mcp",
      dryRun: false,
      force: true,
    });
    expect(result.imported).toEqual(["x"]);
    const text = await fs.readFile(
      path.join(root, ".agents", "mcps", "x.json"),
      "utf8",
    );
    expect(JSON.parse(text).command).toBe("new-binary");
  });
});

describe("runImport --type=both", () => {
  test("imports skills and MCPs in one run", async () => {
    await writeFile(
      path.join(root, ".claude", "skills", "hello", "SKILL.md"),
      `---\nname: hello\ndescription: Say hi.\n---\n# Hello\n`,
    );
    await writeFile(
      path.join(root, ".cursor", "mcp.json"),
      JSON.stringify({
        mcpServers: { localx: { command: "npx", args: ["@x/y"] } },
      }),
    );
    const result = await runImport({
      cwd: root,
      scope: "project",
      type: "both",
      dryRun: false,
      force: false,
    });
    expect(result.imported.sort()).toEqual(["hello", "localx"]);
    await fs.stat(path.join(root, ".agents", "skills", "hello", "SKILL.md"));
    await fs.stat(path.join(root, ".agents", "mcps", "localx.json"));
  });
});

describe("runImport --type=mcp (scope + dry-run)", () => {
  test("--global reads from $HOME and writes under $HOME/.agents/mcps/", async () => {
    await writeFile(
      path.join(homeDir, ".cursor", "mcp.json"),
      JSON.stringify({
        mcpServers: { g: { command: "global-cmd" } },
      }),
    );
    const result = await runImport({
      cwd: root,
      scope: "global",
      type: "mcp",
      dryRun: false,
      force: false,
    });
    expect(result.imported).toEqual(["g"]);
    await fs.stat(path.join(homeDir, ".agents", "mcps", "g.json"));
    await expect(
      fs.stat(path.join(root, ".agents", "mcps", "g.json")),
    ).rejects.toThrow();
  });

  test("--dry-run plans without writing", async () => {
    await writeFile(
      path.join(root, ".cursor", "mcp.json"),
      JSON.stringify({
        mcpServers: { d: { command: "x" } },
      }),
    );
    const result = await runImport({
      cwd: root,
      scope: "project",
      type: "mcp",
      dryRun: true,
      force: false,
    });
    expect(result.imported).toEqual(["d"]);
    await expect(
      fs.stat(path.join(root, ".agents", "mcps", "d.json")),
    ).rejects.toThrow();
  });
});
