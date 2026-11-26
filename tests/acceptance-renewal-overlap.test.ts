// Acceptance tests for renewal overlap, shared action counts, and stop during issue. Do not edit to make a change pass.
// The store and the site share one fake clock, so cases that move time do not sleep.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { issueMandate, memoryStore, type LeasePlan } from "@task-mandate/core";
import { Renewer, signRequest } from "@task-mandate/node";
import { createApp } from "../apps/demo-site/src/app";

const SITE = "https://court.example";
const T0 = new Date("2026-12-01T00:00:00Z");
const at = (min: number) => new Date(T0.getTime() + min * 60_000);
const sec = (d: Date) => Math.floor(d.getTime() / 1000);

async function ed25519Jwk() {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  return { priv: await crypto.subtle.exportKey("jwk", kp.privateKey), pub: await crypto.subtle.exportKey("jwk", kp.publicKey) };
}

let clock: Date;
let principal: Awaited<ReturnType<typeof ed25519Jwk>>;
let agent: Awaited<ReturnType<typeof ed25519Jwk>>;
const now = () => clock;

beforeEach(async () => {
  clock = T0;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  principal = await ed25519Jwk();
  agent = await ed25519Jwk();
});
afterEach(() => vi.useRealTimers());

function setClock(d: Date) {
  clock = d;
  vi.setSystemTime(d);
}

const plan: LeasePlan = { taskId: "task-1", start: T0, end: at(7 * 24 * 60), chunkSec: 600 };

function chunk(signer: { priv: JsonWebKey }, opts: { tid: string; max: number; taskEnd?: Date }) {
  return issueMandate({
    principalKey: signer.priv,
    agentPublicKey: agent.pub,
    audience: SITE,
    task: { type: "reserve", resource: "court-3" },
    limits: { maxActions: opts.max },
    taskId: opts.tid,
    ...(opts.taskEnd ? { taskEnd: opts.taskEnd } : {}),
    notBefore: clock,
    durationSec: 600,
    now: clock,
  });
}

async function reserve(app: ReturnType<typeof createApp>, mandate: string) {
  const req = new Request(`${SITE}/reserve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ facility: "court-3" }),
  });
  return app.request(await signRequest(req, { mandate, agentKey: agent.priv, now: clock }));
}

describe("the action limit lasts until the task end", () => {
  it("after a new chunk and the old chunk's expiry, a one-action task still cannot reserve again", async () => {
    const app = createApp({ origin: SITE, store: memoryStore({ now }), seats: { "court-3": 9 }, now });
    expect((await reserve(app, await chunk(principal, { tid: "t1", max: 1, taskEnd: plan.end }))).status).toBe(200);
    setClock(at(5));
    const second = await chunk(principal, { tid: "t1", max: 1, taskEnd: plan.end });
    setClock(at(11)); // the first chunk has expired
    const res = await reserve(app, second);
    expect((await res.json()).code).toBe("LIMIT_EXCEEDED");
    setClock(at(3 * 24 * 60)); // still the same three days later
    const third = await chunk(principal, { tid: "t1", max: 1, taskEnd: plan.end });
    expect((await (await reserve(app, third)).json()).code).toBe("LIMIT_EXCEEDED");
  });

  it("a mandate whose task end is before the chunk expiry cannot be issued", async () => {
    await expect(chunk(principal, { tid: "t1", max: 1, taskEnd: at(5) })).rejects.toThrow();
  });
});

describe("another person's task id", () => {
  it("another person using the same task id does not change my count", async () => {
    const intruder = await ed25519Jwk();
    const app = createApp({ origin: SITE, store: memoryStore({ now }), seats: { "court-3": 9 }, now });
    const mine = await chunk(principal, { tid: "shared-task", max: 1 });
    const theirs = await chunk(intruder, { tid: "shared-task", max: 5 });
    expect((await reserve(app, theirs)).status).toBe(200);
    expect((await reserve(app, theirs)).status).toBe(200);
    expect((await reserve(app, mine)).status).toBe(200);
  });
});

describe("stop overlapping issue", () => {
  it("stopping while issue is in flight does not keep the new mandate", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const write = vi.fn(async () => {});
    const r = new Renewer({
      plan,
      now,
      write,
      issue: async ({ nbf, exp }) => {
        await gate;
        return issueMandate({
          principalKey: principal.priv,
          agentPublicKey: agent.pub,
          audience: SITE,
          task: { type: "reserve" },
          taskId: plan.taskId,
          taskEnd: plan.end,
          notBefore: nbf,
          durationSec: sec(exp) - sec(nbf),
          now: clock,
        });
      },
    });
    const pending = r.tick();
    r.stop();
    release();
    expect(await pending).toBe("stopped");
    expect(write).not.toHaveBeenCalled();
    expect(r.current()).toBeUndefined();
  });

  it("overlapping ticks issue the mandate only once", async () => {
    const issue = vi.fn(async ({ nbf, exp }: { nbf: Date; exp: Date }) =>
      issueMandate({
        principalKey: principal.priv,
        agentPublicKey: agent.pub,
        audience: SITE,
        task: { type: "reserve" },
        taskId: plan.taskId,
        taskEnd: plan.end,
        notBefore: nbf,
        durationSec: sec(exp) - sec(nbf),
        now: clock,
      }),
    );
    const r = new Renewer({ plan, now, write: async () => {}, issue });
    const results = await Promise.all([r.tick(), r.tick(), r.tick()]);
    expect(issue).toHaveBeenCalledTimes(1);
    expect(results.filter((x) => x === "issued")).toHaveLength(1);
  });
});
