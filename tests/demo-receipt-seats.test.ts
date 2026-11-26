import { describe, expect, it } from "vitest";
import { receiptFromBytes } from "../apps/demo-site/src/receipt.js";
import { memorySeatBook } from "../apps/demo-site/src/seats.js";

describe("receipt ids and seat release", () => {
  it("bytes at or above 252 are dropped, and the rest become 8 characters", () => {
    expect(receiptFromBytes(new Uint8Array([252, 255, 0, 1, 2, 3, 4, 5, 6, 7]))).toBe("MO-ABCDEFGH");
    expect(receiptFromBytes(new Uint8Array([252, 253]))).toBeUndefined();
  });

  it("releasing a taken seat restores it", async () => {
    const book = memorySeatBook({ "court-3": 2 });
    expect(await book.take("court-3")).toMatchObject({ status: "ok", remaining: 1 });
    await book.release("court-3");
    expect(await book.list()).toMatchObject({ "court-3": 2 });
  });
});
