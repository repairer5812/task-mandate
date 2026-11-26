import { decodeMandateUnverified, ISSUER_PREFIX, memoryStore, type Store, thumbprint } from "@task-mandate/core";
import { actionCountKey, CLAIM } from "@task-mandate/core/internal";
import { type MandateEnv, type MandateMiddlewareConfig, taskMandate } from "@task-mandate/node";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { ed25519, issue, type KeyPair, NOW, SITE, signed } from "../../core/test/helpers.js";

let principal: KeyPair;
let agent: KeyPair;

beforeEach(async () => {
  principal = await ed25519();
  agent = await ed25519();
});

function countingStore(): { store: Store; consumed: () => number; refunded: () => number } {
  const inner = memoryStore();
  const calls = { consumed: 0, refunded: 0 };
  return {
    store: {
      claimNonce: (nonce, ttlSec) => inner.claimNonce(nonce, ttlSec),
      consumeAction: async (jti, max, ttlSec) => {
        const ok = await inner.consumeAction(jti, max, ttlSec);
        if (ok) calls.consumed += 1;
        return ok;
      },
      refundAction: async (jti) => {
        calls.refunded += 1;
        await inner.refundAction(jti);
      },
      claimPersonSlot: (input) => inner.claimPersonSlot(input),
    },
    consumed: () => calls.consumed,
    refunded: () => calls.refunded,
  };
}

describe("middleware config", () => {
  it("store is required on the config type, and a missing store is STORE_REQUIRED", () => {
    type StoreIsRequired = undefined extends MandateMiddlewareConfig["store"] ? false : true;
    const required: StoreIsRequired = true;
    expect(required).toBe(true);
    expect(() => taskMandate({ origin: SITE } as MandateMiddlewareConfig)).toThrow(expect.objectContaining({ code: "STORE_REQUIRED" }));
  });
});

describe("middleware action count", () => {
  for (const status of [400, 403, 409, 500] as const) {
    it(`refunds the count used on that request when the handler returns ${status}`, async () => {
      const counted = countingStore();
      let fail = true;
      const app = new Hono<MandateEnv>();
      const mandate = taskMandate({ origin: SITE, store: counted.store, now: () => NOW });
      app.post("/reserve", mandate({ requireTask: { type: "reserve" } }), (c) => {
        if (fail) return c.json({ error: "no" }, status);
        return c.json({ ok: true });
      });
      const token = await issue(principal, agent);
      expect((await app.request(await signed(token, agent.priv))).status).toBe(status);
      expect(counted.consumed()).toBe(1);
      expect(counted.refunded()).toBe(1);
      fail = false;
      expect((await app.request(await signed(token, agent.priv))).status).toBe(200);
      expect(counted.consumed()).toBe(2);
      expect(counted.refunded()).toBe(1);
      expect((await app.request(await signed(token, agent.priv))).status).toBe(403);
    });
  }

  it("refunds the count when the handler throws", async () => {
    const counted = countingStore();
    let explode = true;
    const app = new Hono<MandateEnv>();
    const mandate = taskMandate({ origin: SITE, store: counted.store, now: () => NOW });
    app.onError((err, c) => c.text(err.message, 500));
    app.post("/reserve", mandate({ requireTask: { type: "reserve" } }), (c) => {
      if (explode) throw new Error("boom");
      return c.json({ ok: true });
    });
    const token = await issue(principal, agent);
    const failed = await app.request(await signed(token, agent.priv));
    expect(failed.status).toBe(500);
    expect(await failed.text()).toBe("boom");
    expect(counted.refunded()).toBe(1);
    explode = false;
    expect((await app.request(await signed(token, agent.priv))).status).toBe(200);
    expect(counted.consumed()).toBe(2);
    expect(counted.refunded()).toBe(1);
  });

  it("refunds the count even when the exception leaves the middleware", async () => {
    const counted = countingStore();
    let explode = true;
    const app = new Hono<MandateEnv>();
    const mandate = taskMandate({ origin: SITE, store: counted.store, now: () => NOW });
    app.onError((err) => {
      throw err;
    });
    app.post("/reserve", mandate({ requireTask: { type: "reserve" } }), (c) => {
      if (explode) throw new Error("boom");
      return c.json({ ok: true });
    });
    const token = await issue(principal, agent);
    await expect(app.request(await signed(token, agent.priv))).rejects.toThrow("boom");
    expect(counted.refunded()).toBe(1);
    explode = false;
    expect((await app.request(await signed(token, agent.priv))).status).toBe(200);
  });

  it("keeps the count when the handler returns 2xx", async () => {
    const counted = countingStore();
    const app = new Hono<MandateEnv>();
    const mandate = taskMandate({ origin: SITE, store: counted.store, now: () => NOW });
    app.post("/reserve", mandate({ requireTask: { type: "reserve" } }), (c) => c.json({ ok: true }));
    const token = await issue(principal, agent);
    expect((await app.request(await signed(token, agent.priv))).status).toBe(200);
    expect(counted.consumed()).toBe(1);
    expect(counted.refunded()).toBe(0);
    const second = await app.request(await signed(token, agent.priv));
    expect(second.status).toBe(403);
    expect(await second.json()).toMatchObject({ decision: "deny", code: "LIMIT_EXCEEDED" });
    expect(counted.refunded()).toBe(0);
  });

  it("a mandate with no action limit is not counted and is not refunded on failure", async () => {
    const counted = countingStore();
    let fail = true;
    const app = new Hono<MandateEnv>();
    const mandate = taskMandate({ origin: SITE, store: counted.store, now: () => NOW });
    app.post("/reserve", mandate({ requireTask: { type: "reserve" } }), (c) => {
      if (fail) return c.json({ error: "bad-request" }, 400);
      return c.json({ ok: true });
    });
    const token = await issue(principal, agent, { limits: undefined });
    expect((await app.request(await signed(token, agent.priv))).status).toBe(400);
    fail = false;
    expect((await app.request(await signed(token, agent.priv))).status).toBe(200);
    expect((await app.request(await signed(token, agent.priv))).status).toBe(200);
    expect(counted.consumed()).toBe(0);
    expect(counted.refunded()).toBe(0);
  });

  it("a route without requireTask does not count actions and does not refund on failure", async () => {
    const counted = countingStore();
    let fail = true;
    const app = new Hono<MandateEnv>();
    const mandate = taskMandate({ origin: SITE, store: counted.store, now: () => NOW });
    app.post("/reserve", mandate({}), (c) => {
      if (fail) return c.json({ error: "bad-request" }, 400);
      return c.json({ ok: true });
    });
    const token = await issue(principal, agent);
    expect((await app.request(await signed(token, agent.priv))).status).toBe(400);
    fail = false;
    expect((await app.request(await signed(token, agent.priv))).status).toBe(200);
    expect((await app.request(await signed(token, agent.priv))).status).toBe(200);
    expect(counted.consumed()).toBe(0);
    expect(counted.refunded()).toBe(0);
  });

  it("a failed request is refunded on the same key of issuer, audience, and task id", async () => {
    const inner = memoryStore();
    const seen: string[] = [];
    const store: Store = {
      claimNonce: (nonce, ttlSec) => inner.claimNonce(nonce, ttlSec),
      consumeAction: async (taskId, max, ttlSec) => {
        seen.push(`consume:${taskId}`);
        return inner.consumeAction(taskId, max, ttlSec);
      },
      refundAction: async (taskId) => {
        seen.push(`refund:${taskId}`);
        await inner.refundAction(taskId);
      },
      claimPersonSlot: (input) => inner.claimPersonSlot(input),
    };
    const app = new Hono<MandateEnv>();
    const mandate = taskMandate({ origin: SITE, store, now: () => NOW });
    app.post("/reserve", mandate({ requireTask: { type: "reserve" } }), (c) => c.json({ error: "bad-request" }, 400));
    const token = await issue(principal, agent, { taskId: "task-9" });
    expect((await app.request(await signed(token, agent.priv))).status).toBe(400);
    const key = actionCountKey(`${ISSUER_PREFIX}${await thumbprint(principal.pub)}`, SITE, "task-9");
    expect(seen).toEqual([`consume:${key}`, `refund:${key}`]);
    expect(decodeMandateUnverified(token)?.payload[CLAIM.jti]).not.toBe("task-9");
  });
});
