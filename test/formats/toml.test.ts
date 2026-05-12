import { describe, expect, test } from "vitest";
import {
  deleteAtPointer,
  getAtPointer,
  parseToml,
  setAtPointer,
  stringifyToml,
} from "../../src/formats/toml.js";

describe("toml formats", () => {
  test("set new key in empty doc", () => {
    const out = setAtPointer({}, "mcp_servers.neon", { url: "https://x" });
    expect(out).toEqual({ mcp_servers: { neon: { url: "https://x" } } });
  });

  test("round-trip via parseToml/stringifyToml", () => {
    const text = '[mcp_servers.neon]\nurl = "https://x"\n';
    const parsed = parseToml(text);
    expect(getAtPointer(parsed, "mcp_servers.neon.url")).toBe("https://x");
    const out = setAtPointer(parsed, "mcp_servers.neon.bearer_token_env_var", "FOO");
    const text2 = stringifyToml(out);
    const parsed2 = parseToml(text2);
    expect(getAtPointer(parsed2, "mcp_servers.neon.url")).toBe("https://x");
    expect(getAtPointer(parsed2, "mcp_servers.neon.bearer_token_env_var")).toBe(
      "FOO",
    );
  });

  test("delete removes the key", () => {
    const start = { mcp_servers: { a: { x: 1 }, b: { y: 2 } } };
    const out = deleteAtPointer(start, "mcp_servers.a");
    expect(out).toEqual({ mcp_servers: { b: { y: 2 } } });
  });

  test("immutable: original untouched on set", () => {
    const start = { mcp_servers: { a: { x: 1 } } };
    setAtPointer(start, "mcp_servers.a.x", 999);
    expect(start.mcp_servers.a.x).toBe(1);
  });

  test("deep nested set", () => {
    const out = setAtPointer({}, "a.b.c.d.e", 5);
    expect(getAtPointer(out, "a.b.c.d.e")).toBe(5);
  });
});
