import { describe, expect, test } from "vitest";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cursorEmitter } from "../../src/emitters/cursor.js";
import { makeInput } from "./_input.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const goldenDir = path.join(here, "..", "fixtures", "golden", "cursor");

describe("cursor emitter", () => {
  test("project-scope output matches golden", async () => {
    const out = cursorEmitter.emit(makeInput("project"));
    await expect(JSON.stringify(out, null, 2) + "\n").toMatchFileSnapshot(
      path.join(goldenDir, "project.json"),
    );
  });

  test("global-scope output matches golden", async () => {
    const out = cursorEmitter.emit(makeInput("global"));
    await expect(JSON.stringify(out, null, 2) + "\n").toMatchFileSnapshot(
      path.join(goldenDir, "global.json"),
    );
  });
});
