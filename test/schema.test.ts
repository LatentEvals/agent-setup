import { describe, expect, test } from "vitest";
import { ServerSchema } from "../src/schema.js";

describe("ServerSchema", () => {
  test("accepts a valid bearer http server", () => {
    const out = ServerSchema.parse({
      name: "neon",
      url: "https://mcp.neon.tech/sse",
      auth: "bearer",
      bearerEnvVar: "NEON_API_KEY",
    });
    expect(out.name).toBe("neon");
    expect(out.auth).toBe("bearer");
  });

  test("accepts a stdio server with auth=none default", () => {
    const out = ServerSchema.parse({
      name: "tool",
      command: "npx",
      args: ["foo"],
    });
    expect(out.auth).toBe("none");
  });

  test("rejects a server with both command and url", () => {
    expect(() =>
      ServerSchema.parse({
        name: "x",
        command: "npx",
        url: "https://x",
      }),
    ).toThrow();
  });

  test("rejects a server with neither command nor url", () => {
    expect(() => ServerSchema.parse({ name: "x" })).toThrow();
  });

  test("rejects bearer auth without bearerEnvVar", () => {
    expect(() =>
      ServerSchema.parse({
        name: "x",
        url: "https://x",
        auth: "bearer",
      }),
    ).toThrow();
  });

  test("rejects bearerEnvVar without auth=bearer", () => {
    expect(() =>
      ServerSchema.parse({
        name: "x",
        url: "https://x",
        bearerEnvVar: "FOO",
      }),
    ).toThrow();
  });

  test("rejects names with underscores", () => {
    expect(() =>
      ServerSchema.parse({
        name: "bad_name",
        url: "https://x",
      }),
    ).toThrow();
  });

  test("rejects uppercase or empty names", () => {
    expect(() =>
      ServerSchema.parse({ name: "Bad", url: "https://x" }),
    ).toThrow();
    expect(() =>
      ServerSchema.parse({ name: "", url: "https://x" }),
    ).toThrow();
  });

  test("rejects names longer than 64 chars", () => {
    const long = "a".repeat(65);
    expect(() =>
      ServerSchema.parse({ name: long, url: "https://x" }),
    ).toThrow();
  });

  test("rejects unknown top-level keys", () => {
    expect(() =>
      ServerSchema.parse({
        name: "x",
        url: "https://x",
        unknownKey: "boom",
      }),
    ).toThrow();
  });

  test("rejects headers on stdio transport", () => {
    expect(() =>
      ServerSchema.parse({
        name: "x",
        command: "npx",
        headers: { "X-Foo": "bar" },
      }),
    ).toThrow();
  });

  test("rejects env on http transport", () => {
    expect(() =>
      ServerSchema.parse({
        name: "x",
        url: "https://x",
        env: { FOO: "bar" },
      }),
    ).toThrow();
  });
});
