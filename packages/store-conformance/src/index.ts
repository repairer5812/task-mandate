// Conformance cases for a store, plus a fake clock and a two-handle atomicity check.
// TTL tests sleep in real time unless `options.now.advance` is given.

import type { Store } from "@task-mandate/core";
import { describe, expect, it } from "vitest";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Clock for store tests. `advance` skips a real wait. */
export type ConformanceNow = (() => Date) & { advance?: (ms: number) => void };

/** Optional fake clock, and a second handle when the store should be checked for atomicity. */
export interface StoreConformanceOptions {
  now?: ConformanceNow;
  makePair?: () => readonly [Store, Store] | Promise<readonly [Store, Store]>;
}

/** Vitest cases for a `Store`. `makePair` adds the two-handle checks. */
export function defineStoreConformance(name: string, makeStore: () => Store | Promise<Store>, options?: StoreConformanceOptions): void {
  const clock = (): Date => (options?.now ? options.now() : new Date());
  const nowSec = () => Math.floor(clock().getTime() / 1000);
  const wait = (ms: number): Promise<void> => {
    const advance = options?.now?.advance;
    if (advance) {
      advance(ms);
      return Promise.resolve();
    }
    return sleep(ms);
  };

  describe(`store contract: ${name}`, () => {
    it("accepts a nonce only once", async () => {
      const s = await makeStore();
      expect(await s.claimNonce("n1", 60)).toBe(true);
      expect(await s.claimNonce("n1", 60)).toBe(false);
      expect(await s.claimNonce("n2", 60)).toBe(true);
    });

    it("accepts a nonce again after ttl", async () => {
      const s = await makeStore();
      expect(await s.claimNonce("n1", 1)).toBe(true);
      await wait(1100);
      expect(await s.claimNonce("n1", 1)).toBe(true);
    });

    it("consumes actions up to max and allows another after refund", async () => {
      const s = await makeStore();
      expect(await s.consumeAction("k", 2, 60)).toBe(true);
      expect(await s.consumeAction("k", 2, 60)).toBe(true);
      expect(await s.consumeAction("k", 2, 60)).toBe(false);
      await s.refundAction("k");
      expect(await s.consumeAction("k", 2, 60)).toBe(true);
      expect(await s.consumeAction("other", 2, 60)).toBe(true);
    });

    it("does not refund below zero", async () => {
      const s = await makeStore();
      await s.refundAction("k");
      await s.refundAction("k");
      expect(await s.consumeAction("k", 1, 60)).toBe(true);
      expect(await s.consumeAction("k", 1, 60)).toBe(false);
    });

    it("returns false immediately when max is 0", async () => {
      const s = await makeStore();
      expect(await s.consumeAction("k", 0, 60)).toBe(false);
    });

    it("does not move an action counter expiry earlier", async () => {
      const s = await makeStore();
      expect(await s.consumeAction("k", 1, 60)).toBe(true);
      expect(await s.consumeAction("k", 1, 1)).toBe(false);
      await wait(1100);
      expect(await s.consumeAction("k", 1, 1)).toBe(false);
    });

    it("does not consume when ttl is 0", async () => {
      const s = await makeStore();
      expect(await s.consumeAction("ttl0", 5, 0)).toBe(false);
      expect(await s.consumeAction("ttl0", 5, 0)).toBe(false);
      expect(await s.consumeAction("ttl0", 5, 60)).toBe(true);
    });

    it("has no previous count at the expiry second", async () => {
      const s = await makeStore();
      expect(await s.consumeAction("edge", 1, 1)).toBe(true);
      await wait(1000);
      expect(await s.consumeAction("edge", 1, 1)).toBe(true);
    });

    it("drops the action counter after ttl", async () => {
      const s = await makeStore();
      expect(await s.consumeAction("k", 1, 1)).toBe(true);
      await wait(1100);
      expect(await s.consumeAction("k", 1, 1)).toBe(true);
    });

    it("does not pass max when consumeAction runs concurrently", async () => {
      const s = await makeStore();
      const results = await Promise.all(Array.from({ length: 20 }, () => s.consumeAction("k", 3, 60)));
      expect(results.filter(Boolean)).toHaveLength(3);
    });

    describe("claimPersonSlot (person slot rules 1 to 5)", () => {
      const base = () => {
        const now = nowSec();
        return { personKey: "idp\u0000p1", taskKey: "t1", agentKeyId: "a1", taskBegin: now - 100, expiresAt: now + 3600, now, minSwitchSec: 600 };
      };

      it("rule 2: ok when the slot is empty", async () => {
        const s = await makeStore();
        expect(await s.claimPersonSlot(base())).toBe("ok");
      });

      it("rule 3: ok for the same task, agent, and start", async () => {
        const s = await makeStore();
        const b = base();
        await s.claimPersonSlot(b);
        expect(await s.claimPersonSlot({ ...b, expiresAt: b.expiresAt + 100 })).toBe("ok");
      });

      it("superseded when the same task has a different agent", async () => {
        const s = await makeStore();
        const b = base();
        await s.claimPersonSlot(b);
        expect(await s.claimPersonSlot({ ...b, agentKeyId: "a2" })).toBe("superseded");
      });

      it("superseded when the same task and agent change only the start, and the original stays ok", async () => {
        const s = await makeStore();
        const b = base();
        await s.claimPersonSlot(b);
        expect(await s.claimPersonSlot({ ...b, taskBegin: b.taskBegin + 50, now: b.now + 700 })).toBe("superseded");
        expect(await s.claimPersonSlot({ ...b, now: b.now + 700 })).toBe("ok");
      });

      it("rule 4: switches to a newer task after the gap, and the previous task stays displaced", async () => {
        const s = await makeStore();
        const b = base();
        await s.claimPersonSlot(b);
        const later = b.now + 601;
        expect(await s.claimPersonSlot({ ...b, taskKey: "t2", agentKeyId: "a2", taskBegin: b.taskBegin + 10, now: later })).toBe("ok");
        expect(await s.claimPersonSlot({ ...b, now: later })).toBe("superseded");
      });

      it("rule 5: a new task is superseded inside the gap", async () => {
        const s = await makeStore();
        const b = base();
        await s.claimPersonSlot(b);
        expect(await s.claimPersonSlot({ ...b, taskKey: "t2", agentKeyId: "a2", taskBegin: b.taskBegin + 10, now: b.now + 10 })).toBe("superseded");
      });

      it("another task with the same or earlier start stays superseded after the gap", async () => {
        const s = await makeStore();
        const b = base();
        await s.claimPersonSlot(b);
        expect(await s.claimPersonSlot({ ...b, taskKey: "t2", now: b.now + 700 })).toBe("superseded");
        expect(await s.claimPersonSlot({ ...b, taskKey: "t3", taskBegin: b.taskBegin - 1, now: b.now + 700 })).toBe("superseded");
      });

      it("a displaced task stays superseded after the new slot expires, until its own expiry", async () => {
        const s = await makeStore();
        const b = base();
        await s.claimPersonSlot(b);
        const later = b.now + 601;
        await s.claimPersonSlot({ ...b, taskKey: "t2", agentKeyId: "a2", taskBegin: b.taskBegin + 10, now: later, expiresAt: later + 60 });
        expect(await s.claimPersonSlot({ ...b, now: later + 120 })).toBe("superseded");
      });

      it("different person keys do not affect each other", async () => {
        const s = await makeStore();
        const b = base();
        await s.claimPersonSlot(b);
        expect(await s.claimPersonSlot({ ...b, personKey: "idp\u0000p2", agentKeyId: "a9" })).toBe("ok");
      });

      it("when different tasks race for the first slot, only one is ok", async () => {
        const s = await makeStore();
        const b = base();
        const results = await Promise.all(Array.from({ length: 10 }, (_, i) => s.claimPersonSlot({ ...b, taskKey: `t${i}`, agentKeyId: `a${i}` })));
        expect(results.filter((result) => result === "ok")).toHaveLength(1);
      });
    });

    const makePair = options?.makePair;
    if (makePair) {
      it("two handles together do not consume more than max", async () => {
        const [left, right] = await makePair();
        const results = await Promise.all([...Array.from({ length: 10 }, () => left.consumeAction("pair-action", 3, 60)), ...Array.from({ length: 10 }, () => right.consumeAction("pair-action", 3, 60))]);
        expect(results.filter(Boolean)).toHaveLength(3);
      });

      it("only one of two handles accepts the same nonce", async () => {
        const [left, right] = await makePair();
        const results = await Promise.all([left.claimNonce("pair-nonce", 60), right.claimNonce("pair-nonce", 60)]);
        expect(results.filter(Boolean)).toHaveLength(1);
      });
    }
  });
}
