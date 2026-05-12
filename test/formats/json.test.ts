import { describe, expect, test } from "vitest";
import {
  deleteAtPointer,
  getAtPointer,
  setAtPointer,
  stringifyJson,
} from "../../src/formats/json.js";

describe("json formats", () => {
  test("set new key creates nested objects", () => {
    const out = setAtPointer({}, "mcpServers.neon", { url: "https://x" });
    expect(out).toEqual({ mcpServers: { neon: { url: "https://x" } } });
  });

  test("set existing key overwrites", () => {
    const start = { mcpServers: { neon: { url: "old" } } };
    const out = setAtPointer(start, "mcpServers.neon", { url: "new" });
    expect(out).toEqual({ mcpServers: { neon: { url: "new" } } });
    // immutability: original untouched
    expect(start.mcpServers.neon.url).toBe("old");
  });

  test("set preserves siblings", () => {
    const start = { mcpServers: { other: { url: "y" } }, foo: 1 };
    const out = setAtPointer(start, "mcpServers.neon", { url: "x" });
    expect(out).toEqual({
      mcpServers: { other: { url: "y" }, neon: { url: "x" } },
      foo: 1,
    });
  });

  test("delete removes key", () => {
    const start = { mcpServers: { a: 1, b: 2 } };
    const out = deleteAtPointer(start, "mcpServers.a") as Record<
      string,
      unknown
    >;
    expect(out).toEqual({ mcpServers: { b: 2 } });
  });

  test("delete on missing path is a no-op", () => {
    const start = { x: 1 };
    const out = deleteAtPointer(start, "y.z");
    expect(out).toEqual({ x: 1 });
  });

  test("get returns deep value or undefined", () => {
    const v = { a: { b: { c: 7 } } };
    expect(getAtPointer(v, "a.b.c")).toBe(7);
    expect(getAtPointer(v, "a.x")).toBe(undefined);
  });

  test("slash separator works equivalently to dots", () => {
    const out = setAtPointer({}, "a/b/c", 1);
    expect(out).toEqual({ a: { b: { c: 1 } } });
  });

  test("stringify round-trips and preserves key order", () => {
    const v = { z: 1, a: 2, m: 3 };
    const text = stringifyJson(v);
    const back = JSON.parse(text);
    expect(Object.keys(back)).toEqual(["z", "a", "m"]);
    expect(text.endsWith("\n")).toBe(true);
  });
});
