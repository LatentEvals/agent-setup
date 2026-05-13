// Unit tests for per-tool MCP reverse-normalizers.

import { describe, expect, test } from "vitest";

import {
  normalizeFromClaude,
  normalizeFromCursor,
  normalizeFromGemini,
  normalizeFromOpenCode,
  normalizeFromCodex,
  parseBearerHeader,
} from "../src/mcp-reverse.js";

describe("parseBearerHeader", () => {
  test("claude: ${VAR}", () => {
    expect(parseBearerHeader("Bearer ${NEON_API_KEY}", "claude")).toEqual({
      kind: "env-var",
      envVar: "NEON_API_KEY",
    });
  });
  test("claude: $VAR (bare)", () => {
    expect(parseBearerHeader("Bearer $NEON_API_KEY", "claude")).toEqual({
      kind: "env-var",
      envVar: "NEON_API_KEY",
    });
  });
  test("cursor: ${env:VAR}", () => {
    expect(parseBearerHeader("Bearer ${env:NEON_API_KEY}", "cursor")).toEqual({
      kind: "env-var",
      envVar: "NEON_API_KEY",
    });
  });
  test("opencode: {env:VAR}", () => {
    expect(parseBearerHeader("Bearer {env:NEON_API_KEY}", "opencode")).toEqual({
      kind: "env-var",
      envVar: "NEON_API_KEY",
    });
  });
  test("cursor uses ${VAR} (wrong syntax) → inline-secret", () => {
    expect(parseBearerHeader("Bearer ${NEON_API_KEY}", "cursor")).toEqual({
      kind: "inline-secret",
    });
  });
  test("literal secret → inline-secret", () => {
    expect(parseBearerHeader("Bearer abc123", "claude")).toEqual({
      kind: "inline-secret",
    });
  });
  test("non-bearer scheme → unrecognized", () => {
    expect(parseBearerHeader("Basic xxx", "claude")).toEqual({
      kind: "unrecognized",
    });
  });
});

describe("normalizeFromClaude", () => {
  test("stdio happy path", () => {
    const r = normalizeFromClaude(
      { command: "npx", args: ["@x/y"], env: { K: "v" } },
      "tool",
    );
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.server).toMatchObject({
        name: "tool",
        command: "npx",
        args: ["@x/y"],
        env: { K: "v" },
        auth: "none",
      });
    }
  });
  test("HTTP + bearer happy path", () => {
    const r = normalizeFromClaude(
      {
        url: "https://mcp.neon.tech/sse",
        headers: { Authorization: "Bearer ${NEON_API_KEY}" },
      },
      "neon",
    );
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.server).toMatchObject({
        name: "neon",
        url: "https://mcp.neon.tech/sse",
        auth: "bearer",
        bearerEnvVar: "NEON_API_KEY",
      });
      expect(r.server.headers).toBeUndefined();
    }
  });
  test("HTTP + inline-secret → reverse-error", () => {
    const r = normalizeFromClaude(
      {
        url: "https://x",
        headers: { Authorization: "Bearer literal-token" },
      },
      "x",
    );
    expect(r.kind).toBe("reverse-error");
  });
  test("non-object → reverse-error", () => {
    const r = normalizeFromClaude("not an object", "x");
    expect(r.kind).toBe("reverse-error");
  });
});

describe("normalizeFromCursor", () => {
  test("HTTP + bearer in cursor syntax", () => {
    const r = normalizeFromCursor(
      {
        url: "https://x",
        headers: { Authorization: "Bearer ${env:MY_KEY}" },
      },
      "x",
    );
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.server).toMatchObject({
        auth: "bearer",
        bearerEnvVar: "MY_KEY",
      });
    }
  });
  test("wrong-tool syntax (cursor entry with ${VAR}) → reverse-error", () => {
    const r = normalizeFromCursor(
      {
        url: "https://x",
        headers: { Authorization: "Bearer ${MY_KEY}" },
      },
      "x",
    );
    expect(r.kind).toBe("reverse-error");
  });
});

describe("normalizeFromGemini", () => {
  test("httpUrl is renamed to url", () => {
    const r = normalizeFromGemini(
      {
        httpUrl: "https://g.example",
        headers: { Authorization: "Bearer ${GEM_KEY}" },
      },
      "g",
    );
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.server.url).toBe("https://g.example");
      expect(r.server.auth).toBe("bearer");
      expect(r.server.bearerEnvVar).toBe("GEM_KEY");
    }
  });
  test("plain url (no httpUrl) also works", () => {
    const r = normalizeFromGemini({ url: "https://g" }, "g");
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") expect(r.server.url).toBe("https://g");
  });
  test("no transport at all → reverse-error", () => {
    const r = normalizeFromGemini({ description: "nothing" }, "x");
    expect(r.kind).toBe("reverse-error");
  });
});

describe("normalizeFromOpenCode", () => {
  test('"local" → unpacks command array + renames environment to env', () => {
    const r = normalizeFromOpenCode(
      {
        type: "local",
        command: ["bash", "-c", "echo hi"],
        environment: { FOO: "1" },
      },
      "t",
    );
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.server).toMatchObject({
        command: "bash",
        args: ["-c", "echo hi"],
        env: { FOO: "1" },
      });
    }
  });
  test('"local" with single-element command array (no args)', () => {
    const r = normalizeFromOpenCode(
      { type: "local", command: ["just-this"] },
      "t",
    );
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.server.command).toBe("just-this");
      expect(r.server.args).toBeUndefined();
    }
  });
  test('"remote" with bearer {env:VAR}', () => {
    const r = normalizeFromOpenCode(
      {
        type: "remote",
        url: "https://o",
        headers: { Authorization: "Bearer {env:O_KEY}" },
      },
      "o",
    );
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.server.auth).toBe("bearer");
      expect(r.server.bearerEnvVar).toBe("O_KEY");
    }
  });
  test("missing type discriminator → reverse-error", () => {
    const r = normalizeFromOpenCode({ command: ["bash"] }, "x");
    expect(r.kind).toBe("reverse-error");
  });
});

describe("normalizeFromCodex", () => {
  test("HTTP with bearer_token_env_var (no header)", () => {
    const r = normalizeFromCodex(
      { url: "https://x", bearer_token_env_var: "MY_KEY" },
      "x",
    );
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.server).toMatchObject({
        url: "https://x",
        auth: "bearer",
        bearerEnvVar: "MY_KEY",
      });
    }
  });
  test("HTTP where both bearer_token_env_var and conflicting header exist → prefer field, warn", () => {
    const r = normalizeFromCodex(
      {
        url: "https://x",
        bearer_token_env_var: "FIELD_KEY",
        headers: { Authorization: "Bearer ${HEADER_KEY}" },
      },
      "x",
    );
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.server.bearerEnvVar).toBe("FIELD_KEY");
      expect(r.warnings.length).toBeGreaterThan(0);
    }
  });
  test("HTTP with only header → parse env var from header", () => {
    const r = normalizeFromCodex(
      {
        url: "https://x",
        headers: { Authorization: "Bearer ${ENV_KEY}" },
      },
      "x",
    );
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.server.bearerEnvVar).toBe("ENV_KEY");
    }
  });
  test("stdio happy path", () => {
    const r = normalizeFromCodex({ command: "npx", args: ["x"] }, "t");
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.server.command).toBe("npx");
    }
  });
});
