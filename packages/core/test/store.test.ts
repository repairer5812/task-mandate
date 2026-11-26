import { memoryStore } from "@task-mandate/core";
import { describe, expect, it } from "vitest";

describe("memoryStore action count", () => {
  it("increments by one under the limit, and does not increment at the limit", async () => {
    const store = memoryStore();
    expect(await store.consumeAction("jti", 2, 60)).toBe(true);
    expect(await store.consumeAction("jti", 2, 60)).toBe(true);
    expect(await store.consumeAction("jti", 2, 60)).toBe(false);
    expect(await store.consumeAction("other", 1, 60)).toBe(true);
  });

  it("does not leave a count when the limit is 0", async () => {
    const store = memoryStore();
    expect(await store.consumeAction("jti", 0, 60)).toBe(false);
    expect(await store.consumeAction("jti", 1, 60)).toBe(true);
  });

  it("refundAction decrements by one and does not go below 0", async () => {
    const store = memoryStore();
    expect(await store.consumeAction("jti", 1, 60)).toBe(true);
    expect(await store.consumeAction("jti", 1, 60)).toBe(false);
    await store.refundAction("jti");
    expect(await store.consumeAction("jti", 1, 60)).toBe(true);

    await store.consumeAction("empty", 5, 60);
    await store.refundAction("empty");
    await store.refundAction("empty");
    await store.refundAction("missing");
    expect(await store.consumeAction("empty", 1, 60)).toBe(true);
    expect(await store.consumeAction("empty", 1, 60)).toBe(false);
  });

  it("does not consume when TTL is under 1 second, then consumes a normal TTL", async () => {
    const store = memoryStore();
    expect(await store.consumeAction("jti", 1, -1)).toBe(false);
    expect(await store.consumeAction("jti", 1, 0)).toBe(false);
    expect(await store.consumeAction("jti", 1, 60)).toBe(true);
    expect(await store.consumeAction("jti", 1, 60)).toBe(false);
  });

  it("expires by the injected clock, and a shorter ttl does not move expiry earlier", async () => {
    let now = 1_000_000;
    const store = memoryStore({ now: () => new Date(now) });
    expect(await store.consumeAction("k", 3, 100)).toBe(true);
    now = 1_050_000;
    expect(await store.consumeAction("k", 3, 10)).toBe(true);
    now = 1_070_000;
    expect(await store.consumeAction("k", 3, 10)).toBe(true);
    expect(await store.consumeAction("k", 3, 10)).toBe(false);
    now = 1_099_999;
    expect(await store.consumeAction("k", 1, 0)).toBe(false);
    now = 1_100_000;
    expect(await store.consumeAction("k", 1, 10)).toBe(true);

    let extended = 0;
    const longer = memoryStore({ now: () => new Date(extended) });
    expect(await longer.consumeAction("e", 2, 10)).toBe(true);
    extended = 1_000;
    expect(await longer.consumeAction("e", 2, 100)).toBe(true);
    extended = 20_000;
    expect(await longer.consumeAction("e", 2, 1)).toBe(false);
  });

  it("check and increment finish together, so concurrent calls do not pass the limit", async () => {
    const store = memoryStore();
    const results = await Promise.all(Array.from({ length: 20 }, () => store.consumeAction("same", 3, 60)));
    expect(results.filter(Boolean)).toHaveLength(3);
  });
});
