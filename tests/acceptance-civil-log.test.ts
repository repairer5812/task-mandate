// Acceptance tests for civil-service application body size, log fields, and log write failures. Do not edit to make a change pass.
import { describe, it, expect } from "vitest";
import { issueMandate, memoryStore } from "@task-mandate/core";
import { signRequest } from "@task-mandate/node";
import { createApp, memoryCivilLog, type CivilLog } from "../apps/demo-site/src/app";

const SITE = "https://court.example";
const NOW = new Date("2026-12-01T00:00:00Z");
const now = () => NOW;

async function ed25519Jwk() {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  return { priv: await crypto.subtle.exportKey("jwk", kp.privateKey), pub: await crypto.subtle.exportKey("jwk", kp.publicKey) };
}

async function setup(civilLog: CivilLog = memoryCivilLog()) {
  const principal = await ed25519Jwk();
  const agent = await ed25519Jwk();
  const app = createApp({ origin: SITE, store: memoryStore({ now }), seats: { "court-3": 5 }, civilLog, now });
  const mandate = (resource?: string) =>
    issueMandate({
      principalKey: principal.priv,
      agentPublicKey: agent.pub,
      audience: SITE,
      task: resource === undefined ? { type: "apply" } : { type: "apply", resource },
      limits: { maxActions: 1 },
      durationSec: 600,
      now: NOW,
    });
  const send = async (body: string, m?: string) => {
    const req = new Request(`${SITE}/civil/apply`, { method: "POST", headers: { "content-type": "application/json" }, body });
    return app.request(m ? await signRequest(req, { mandate: m, agentKey: agent.priv, now: NOW }) : req);
  };
  const log = async () => (await (await app.request(`${SITE}/civil/log`)).json()).entries as Array<Record<string, unknown>>;
  return { app, mandate, send, log };
}

describe("body cap", () => {
  it("a body over 1024 bytes is 413 before mandate checks", async () => {
    const { send, log } = await setup();
    const big = JSON.stringify({ service: "basic-pension", pad: "x".repeat(2000) });
    const res = await send(big);
    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe("too-large");
    expect((await log())[0]).toEqual({ at: NOW.toISOString(), status: 413, code: "too-large", service: null, task: null });
  });

  it("an oversized body is 413 even with a mandate", async () => {
    const { send, mandate } = await setup();
    const big = JSON.stringify({ service: "basic-pension", pad: "x".repeat(2000) });
    expect((await send(big, await mandate("basic-pension"))).status).toBe(413);
  });
});

describe("log fields", () => {
  it("task is cut at 64 characters", async () => {
    const { send, mandate, log } = await setup();
    await send(JSON.stringify({ service: 3 }), await mandate("r".repeat(2000)));
    const [entry] = await log();
    expect(entry.status).toBe(400);
    expect(String(entry.task).length).toBeLessThanOrEqual(64);
    expect(String(entry.task).startsWith("apply:rrr")).toBe(true);
  });

  it("a mandate without a resource keeps only the type in task", async () => {
    const { send, mandate, log } = await setup();
    await send(JSON.stringify({ service: 3 }), await mandate());
    expect((await log())[0].task).toBe("apply");
  });

  it("the log response is not cached", async () => {
    const { app } = await setup();
    expect((await app.request(`${SITE}/civil/log`)).headers.get("cache-control")).toBe("no-store");
  });
});

describe("log failure", () => {
  it("a failed log write still returns 200 and a receipt id", async () => {
    const broken: CivilLog = {
      append: async () => {
        throw new Error("down");
      },
      recent: async () => [],
    };
    const { send, mandate } = await setup(broken);
    const res = await send(JSON.stringify({ service: "basic-pension" }), await mandate("basic-pension"));
    expect(res.status).toBe(200);
    expect((await res.json()).receiptNo).toMatch(/^MO-[A-Z0-9]{8}$/);
  });
});
