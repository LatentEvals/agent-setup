// Unit tests for runInteractiveInstall.
//
// We mock the prompts module so no TTY is opened. We also stub @clack/prompts
// directly so intro/outro/note/spinner produce no real output.

import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

// Stub the prompts module before importing flow.
vi.mock("../src/ui/prompts.js", () => {
  return {
    pickAgents: vi.fn(),
    pickScope: vi.fn(),
    pickSkills: vi.fn(),
    pickMcps: vi.fn(),
    confirmProceed: vi.fn(),
  };
});

// Stub clack itself so the spinner/note calls are silent and don't touch TTY.
vi.mock("@clack/prompts", async () => {
  return {
    intro: vi.fn(),
    outro: vi.fn(),
    cancel: vi.fn(),
    note: vi.fn(),
    log: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), success: vi.fn() },
    spinner: () => ({
      start: vi.fn(),
      stop: vi.fn(),
      message: vi.fn(),
    }),
    isCancel: (v: unknown) =>
      typeof v === "symbol" && v.toString() === "Symbol(clack:cancel)",
    confirm: vi.fn(),
    select: vi.fn(),
    multiselect: vi.fn(),
  };
});

// Imports must come after vi.mock for the stubs to take effect.
const { runInteractiveInstall } = await import("../src/ui/flow.js");
const promptsMod = await import("../src/ui/prompts.js");

let root: string;
let homeDir: string;
let prevHome: string | undefined;
let prevCwd: string;

async function mkdirp(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true });
}

async function writeFile(p: string, body: string): Promise<void> {
  await mkdirp(path.dirname(p));
  await fs.writeFile(p, body, "utf8");
}

async function seedFixtureAgents(r: string): Promise<void> {
  await writeFile(
    path.join(r, ".agents", "skills", "hello", "SKILL.md"),
    `---\nname: hello\ndescription: Say hello.\n---\n# Hello\n`,
  );
  await writeFile(
    path.join(r, ".agents", "mcps", "neon.json"),
    JSON.stringify(
      {
        name: "neon",
        url: "https://mcp.neon.tech/sse",
        auth: "bearer",
        bearerEnvVar: "AGENT_SETUP_TEST_NEON_KEY",
      },
      null,
      2,
    ),
  );
  await mkdirp(path.join(r, ".claude"));
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "agent-setup-flow-"));
  homeDir = await fs.mkdtemp(path.join(tmpdir(), "agent-setup-flow-home-"));
  prevHome = process.env["HOME"];
  process.env["HOME"] = homeDir;
  prevCwd = process.cwd();
  process.chdir(root);
  // Reset all prompt mocks.
  for (const fn of Object.values(promptsMod)) {
    if (typeof fn === "function" && "mockReset" in fn) {
      (fn as ReturnType<typeof vi.fn>).mockReset();
    }
  }
  // Make sure the test env var isn't set so we can detect the warning.
  delete process.env["AGENT_SETUP_TEST_NEON_KEY"];
});

afterEach(async () => {
  process.chdir(prevCwd);
  if (prevHome === undefined) delete process.env["HOME"];
  else process.env["HOME"] = prevHome;
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(homeDir, { recursive: true, force: true });
});

describe("runInteractiveInstall — cancel propagation", () => {
  test("pickAgents cancel → cancelled + exitCode 130", async () => {
    await seedFixtureAgents(root);
    vi.mocked(promptsMod.pickAgents).mockResolvedValueOnce({ cancelled: true });

    const r = await runInteractiveInstall({
      repo: ".",
      cwd: root,
      type: "both",
      scope: "project",
      tool: null,
      dryRun: false,
      force: false,
    });
    expect(r.cancelled).toBe(true);
    expect(r.exitCode).toBe(130);
    expect(promptsMod.pickAgents).toHaveBeenCalledTimes(1);
    expect(promptsMod.pickSkills).not.toHaveBeenCalled();
  });
});

describe("runInteractiveInstall — --type=mcp skips skill prompt", () => {
  test("pickSkills not called when type='mcp'", async () => {
    await seedFixtureAgents(root);
    vi.mocked(promptsMod.pickAgents).mockResolvedValueOnce({
      cancelled: false,
      selected: ["claude"],
    });
    vi.mocked(promptsMod.pickMcps).mockResolvedValueOnce({
      cancelled: false,
      selected: ["neon"],
    });
    vi.mocked(promptsMod.confirmProceed).mockResolvedValueOnce({
      cancelled: false,
      proceed: true,
    });

    const r = await runInteractiveInstall({
      repo: ".",
      cwd: root,
      type: "mcp",
      scope: "project",
      tool: null,
      dryRun: false,
      force: false,
    });
    expect(promptsMod.pickSkills).not.toHaveBeenCalled();
    expect(promptsMod.pickMcps).toHaveBeenCalledTimes(1);
    expect(r.cancelled).toBe(false);
    expect(r.exitCode).toBe(0);
  });
});

describe("runInteractiveInstall — --project flag bypasses scope prompt", () => {
  test("pickScope not called when scope is set", async () => {
    await seedFixtureAgents(root);
    vi.mocked(promptsMod.pickAgents).mockResolvedValueOnce({
      cancelled: false,
      selected: ["claude"],
    });
    vi.mocked(promptsMod.pickSkills).mockResolvedValueOnce({
      cancelled: false,
      selected: ["hello"],
    });
    vi.mocked(promptsMod.pickMcps).mockResolvedValueOnce({
      cancelled: false,
      selected: ["neon"],
    });
    vi.mocked(promptsMod.confirmProceed).mockResolvedValueOnce({
      cancelled: false,
      proceed: true,
    });

    const r = await runInteractiveInstall({
      repo: ".",
      cwd: root,
      type: "both",
      scope: "project",
      tool: null,
      dryRun: false,
      force: false,
    });
    expect(promptsMod.pickScope).not.toHaveBeenCalled();
    expect(r.exitCode).toBe(0);
  });
});

describe("runInteractiveInstall — env-var unset warning", () => {
  test("flow continues but emits a note for unset bearer var", async () => {
    await seedFixtureAgents(root);
    const clack = await import("@clack/prompts");
    const noteSpy = vi.mocked(clack.note);
    noteSpy.mockClear();

    vi.mocked(promptsMod.pickAgents).mockResolvedValueOnce({
      cancelled: false,
      selected: ["claude"],
    });
    vi.mocked(promptsMod.pickSkills).mockResolvedValueOnce({
      cancelled: false,
      selected: ["hello"],
    });
    vi.mocked(promptsMod.pickMcps).mockResolvedValueOnce({
      cancelled: false,
      selected: ["neon"],
    });
    vi.mocked(promptsMod.confirmProceed).mockResolvedValueOnce({
      cancelled: false,
      proceed: true,
    });

    const r = await runInteractiveInstall({
      repo: ".",
      cwd: root,
      type: "both",
      scope: "project",
      tool: null,
      dryRun: false,
      force: false,
    });
    expect(r.cancelled).toBe(false);
    // Find a note call that mentions the env var.
    const allNotes = noteSpy.mock.calls.map((c) => c.join(" "));
    const matched = allNotes.some(
      (s) =>
        typeof s === "string" &&
        s.includes("AGENT_SETUP_TEST_NEON_KEY") &&
        s.toLowerCase().includes("env"),
    );
    expect(matched).toBe(true);
  });
});
