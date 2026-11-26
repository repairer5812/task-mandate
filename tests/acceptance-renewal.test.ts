// Acceptance tests for renewal. Do not edit to make a change pass.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { issueMandate, memoryStore, nextRenewal, decodeMandateUnverified, type LeasePlan } from "@task-mandate/core";
import { Renewer, signRequest, mandatedFetch } from "@task-mandate/node";
import { createApp } from "../apps/demo-site/src/app";

const SITE = "https://court.example";
const T0 = new Date("2026-12-01T00:00:00Z");
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const sec = (d: Date) => Math.floor(d.getTime() / 1000);

async function ed25519Jwk() {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  return { priv: await crypto.subtle.exportKey("jwk", kp.privateKey), pub: await crypto.subtle.exportKey("jwk", kp.publicKey) };
}

const plan: LeasePlan = { taskId: "task-1", start: T0, end: at(60), chunkSec: 600 };

describe("renewal plan nextRenewal", () => {
  it("the first call issues a chunk", () => {
    expect(nextRenewal(plan, T0, undefined, false)).toEqual({ issue: true, nbf: T0, exp: at(10) });
  });

  it("waits when more than half the chunk remains", () => {
    expect(nextRenewal(plan, at(4), { nbf: T0, exp: at(10) }, false)).toEqual({ issue: false, reason: "waiting" });
  });

  it("issues again when the remaining time is at most half a chunk", () => {
    expect(nextRenewal(plan, at(5), { nbf: T0, exp: at(10) }, false)).toEqual({ issue: true, nbf: at(5), exp: at(15) });
  });

  it("a chunk past the task end is cut at the end", () => {
    expect(nextRenewal(plan, at(54), { nbf: at(50), exp: at(60) }, false)).toEqual({ issue: false, reason: "waiting" });
    expect(nextRenewal(plan, at(56), { nbf: at(46), exp: at(56) }, false)).toEqual({ issue: true, nbf: at(56), exp: at(60) });
  });

  it("after the task end, the reason is finished", () => {
    expect(nextRenewal(plan, at(60), undefined, false)).toEqual({ issue: false, reason: "finished" });
  });

  it("before the start, it does not issue", () => {
    expect(nextRenewal({ ...plan, start: at(10) }, T0, undefined, false)).toEqual({ issue: false, reason: "not-started" });
  });

  it("stopped wins over every other reason", () => {
    expect(nextRenewal(plan, at(5), { nbf: T0, exp: at(10) }, true)).toEqual({ issue: false, reason: "stopped" });
  });

  it("a bad plan is an error", () => {
    expect(() => nextRenewal({ ...plan, chunkSec: 0 }, T0, undefined, false)).toThrow();
    expect(() => nextRenewal({ ...plan, end: T0 }, T0, undefined, false)).toThrow();
  });
});

describe("renewer and the site", () => {
  let principal: Awaited<ReturnType<typeof ed25519Jwk>>;
  let agent: Awaited<ReturnType<typeof ed25519Jwk>>;
  let clock: Date;

  beforeEach(async () => {
    principal = await ed25519Jwk();
    agent = await ed25519Jwk();
    clock = T0;
  });

  function renewer(maxActions?: number) {
    const written: string[] = [];
    const r = new Renewer({
      plan,
      now: () => clock,
      write: async (m) => {
        written.push(m);
      },
      issue: ({ nbf, exp }) =>
        issueMandate({
          principalKey: principal.priv,
          agentPublicKey: agent.pub,
          audience: SITE,
          task: { type: "reserve", resource: "court-3" },
          ...(maxActions !== undefined ? { limits: { maxActions } } : {}),
          taskId: plan.taskId,
          notBefore: nbf,
          durationSec: sec(exp) - sec(nbf),
          now: clock,
        }),
    });
    return { r, written };
  }

  async function reserve(app: ReturnType<typeof createApp>, mandate: string | (() => string)) {
    const req = new Request(`${SITE}/reserve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ facility: "court-3" }),
    });
    return app.request(await signRequest(req, { mandate, agentKey: agent.priv, now: clock }));
  }

  it("a renewed chunk keeps the task id and gets a new mandate id", async () => {
    const { r, written } = renewer();
    expect(await r.tick()).toBe("issued");
    clock = at(3);
    expect(await r.tick()).toBe("waiting");
    clock = at(5);
    expect(await r.tick()).toBe("issued");
    expect(written).toHaveLength(2);
    const [a, b] = written.map((m) => decodeMandateUnverified(m)!.payload);
    expect(a.tid).toBe("task-1");
    expect(b.tid).toBe("task-1");
    expect(a.jti).not.toBe(b.jti);
    expect(r.current()).toBe(written[1]);
  });

  it("renewing a chunk does not reset the task action limit", async () => {
    const store = memoryStore();
    const app = createApp({ origin: SITE, store, seats: { "court-3": 5 }, now: () => clock });
    const { r } = renewer(1);
    await r.tick();
    expect((await reserve(app, r.current()!)).status).toBe(200);
    clock = at(6);
    expect(await r.tick()).toBe("issued");
    const res = await reserve(app, r.current()!);
    expect((await res.json()).code).toBe("LIMIT_EXCEEDED");
  });

  it("stop issues nothing more, and the site rejects the last chunk after it expires", async () => {
    const app = createApp({ origin: SITE, store: memoryStore(), seats: { "court-3": 5 }, now: () => clock });
    const { r, written } = renewer(5);
    await r.tick();
    const last = r.current()!;
    clock = at(2);
    r.stop();
    clock = at(6);
    expect(await r.tick()).toBe("stopped");
    expect(written).toHaveLength(1);
    // The last chunk is still valid (expires at(10)).
    clock = at(7);
    expect((await reserve(app, last)).status).toBe(200);
    // Rejected after the chunk length (10 min) plus clock skew (30 s).
    clock = new Date(at(10).getTime() + 31_000);
    expect((await (await reserve(app, last)).json()).code).toBe("EXPIRED");
  });

  it("after the task end, the renewer reports finished", async () => {
    const { r } = renewer();
    await r.tick();
    clock = at(60);
    expect(await r.tick()).toBe("finished");
  });

  it("the agent uses the latest mandate on each request", async () => {
    const app = createApp({ origin: SITE, store: memoryStore(), seats: { "court-3": 5 }, now: () => clock });
    const { r } = renewer(5);
    await r.tick();
    const first = r.current();
    clock = at(5);
    await r.tick();
    expect(r.current()).not.toBe(first);
    const provider = vi.fn(() => r.current()!);
    const res = await reserve(app, provider);
    expect(res.status).toBe(200);
    expect(provider).toHaveBeenCalled();
    expect((await res.json()).ok).toBe(true);
  });

  it("mandatedFetch also accepts a mandate supplier", async () => {
    const { r } = renewer();
    await r.tick();
    const fake = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fake);
    try {
      await mandatedFetch(`${SITE}/slots`, undefined, { mandate: async () => r.current()!, agentKey: agent.priv, now: clock });
      expect(fake).toHaveBeenCalledTimes(1);
      const sent = fake.mock.calls[0]![0] as Request;
      expect(sent.headers.get("agent-mandate")).toBe(r.current());
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
