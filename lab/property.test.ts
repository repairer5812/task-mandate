import { expect, it } from "vitest";
import { runProperties } from "./property";

it("a tampered mandate is denied and time decisions match the order", async () => {
  const result = await runProperties();
  expect(result.tamper.allowed).toBe(0);
  expect(result.time.mismatches).toBe(0);
  expect(result.time.boundaryFails).toEqual([]);
  expect(result.tamper.runs).toBeGreaterThanOrEqual(1000);
  expect(result.time.runs).toBeGreaterThanOrEqual(1000);
}, 300_000);
