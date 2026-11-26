// Acceptance tests for expiry, refund, agent checks, demo limits, and request bounds. Do not edit to make a change pass.
import { describe, it, expect, vi } from "vitest";
import { mkdtemp, readFile, mkdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { issueMandate, memoryStore, verifyRequest, TaskMandateError, assertVerifierConfig } from "@task-mandate/core";
import { advanceAction } from "@task-mandate/core/internal";
import { signRequest, mandatedFetch } from "@task-mandate/node";
import { createApp, memoryCivilLog, memorySimBudget } from "../apps/demo-site/src/app";

const SITE = "https://court.example";
const T0 = new Date("2026-12-01T00:00:00Z");
const sec = (d: Date) => Math.floor(d.getTime() / 1000);

async function ed25519Jwk() {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  return { priv: await crypto.subtle.exportKey("jwk", kp.privateKey), pub: await crypto.subtle.exportKey("jwk", kp.publicKey) };
}

async function fixture(maxActions = 1, durationSec = 600) {
  const principal = await ed25519Jwk(), agent = await ed25519Jwk();
  const mandate = await issueMandate({
    principalKey: principal.priv,
    agentPublicKey: agent.pub,
    audience: SITE,
    task: { type: "reserve", resource: "court-3" },
    limits: { maxActions },
    durationSec,
    now: T0,
  });
  const sign = (now: Date, url = `${SITE}/reserve`) =>
    signRequest(new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }), { mandate, agentKey: agent.priv, now });
  return { principal, agent, mandate, sign };
}

const route = { requireTask: { type: "reserve" } };

describe("action count at the expiry boundary", () => {
  it("the second at exp + skew is EXPIRED, and the count is not released in that second", async () => {
    const f = await fixture(1, 1800);
    const store = memoryStore({ now: () => new Date(T0.getTime() + 1830_000) });
    const at = new Date(T0.getTime() + 1830_000); // exp(1800) + skew(30)
    for (let i = 0; i < 3; i++) {
      const d = await verifyRequest(await f.sign(at), { origin: SITE }, route, store, at);
      expect(d).toMatchObject({ decision: "deny", code: "EXPIRED" });
    }
  });

  it("one second earlier, only one allow", async () => {
    const f = await fixture(1, 1800);
    const at = new Date(T0.getTime() + 1829_000);
    const store = memoryStore({ now: () => at });
    expect((await verifyRequest(await f.sign(at), { origin: SITE }, route, store, at)).decision).toBe("allow");
    expect(await verifyRequest(await f.sign(at), { origin: SITE }, route, store, at)).toMatchObject({ code: "LIMIT_EXCEEDED" });
  });

  it("a TTL under 1 second does not consume", async () => {
    expect(advanceAction(undefined, 1000, 5, 0).allowed).toBe(false);
    const store = memoryStore();
    expect(await store.consumeAction("k", 5, 0)).toBe(false);
    expect(await store.consumeAction("k", 5, 0)).toBe(false);
  });
});

describe("public verifier refund", () => {
  it("refund() on an allow undoes the action once", async () => {
    const f = await fixture(1);
    const store = memoryStore({ now: () => T0 });
    const d = await verifyRequest(await f.sign(T0), { origin: SITE }, route, store, T0);
    expect(d.decision).toBe("allow");
    if (d.decision !== "allow") return;
    await d.refund();
    await d.refund();
    expect((await verifyRequest(await f.sign(T0), { origin: SITE }, route, store, T0)).decision).toBe("allow");
    expect(await verifyRequest(await f.sign(T0), { origin: SITE }, route, store, T0)).toMatchObject({ code: "LIMIT_EXCEEDED" });
  });
});

describe("agent-side checks", () => {
  it("does not send to a different audience", async () => {
    const f = await fixture();
    const fake = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fake);
    try {
      await expect(mandatedFetch("https://evil.example/reserve", undefined, { mandate: f.mandate, agentKey: f.agent.priv, now: T0 })).rejects.toBeInstanceOf(TaskMandateError);
      expect(fake).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not send a mandate with a broken signature", async () => {
    const f = await fixture();
    const [h, p, s] = f.mandate.split("~")[0]!.split(".");
    const payload = JSON.parse(Buffer.from(p!, "base64url").toString());
    payload.aud = "https://evil.example";
    const forged = `${h}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${s}~`;
    const fake = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fake);
    try {
      await expect(mandatedFetch("https://evil.example/x", undefined, { mandate: forged, agentKey: f.agent.priv, now: T0 })).rejects.toBeInstanceOf(TaskMandateError);
      expect(fake).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not send an expired mandate", async () => {
    const f = await fixture(1, 600);
    const fake = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fake);
    try {
      await expect(mandatedFetch(`${SITE}/reserve`, undefined, { mandate: f.mandate, agentKey: f.agent.priv, now: new Date(T0.getTime() + 700_000) })).rejects.toBeInstanceOf(TaskMandateError);
      expect(fake).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("demo server", () => {
  const app = (sim = {}) => createApp({ origin: SITE, store: memoryStore({ now: () => T0 }), seats: { "court-3": 5 }, civilLog: memoryCivilLog(), now: () => T0, sim });
  const big = JSON.stringify({ text: "기초연금", pad: "x".repeat(2000) });
  const post = (a: ReturnType<typeof app>, p: string, body: string, headers: Record<string, string> = {}) =>
    a.request(new Request(`${SITE}${p}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body }));

  it("interpret, attest, and reserve reject an oversized body with 413", async () => {
    const llm = vi.fn(async () => ({}));
    const a = app({ interpret: llm });
    expect((await post(a, "/sim/interpret", big)).status).toBe(413);
    expect((await post(a, "/sim/attest", big)).status).toBe(413);
    expect((await post(a, "/reserve", big)).status).toBe(413);
    expect(llm).not.toHaveBeenCalled();
  });

  it("reserve allows 20 requests per IP per 60 seconds", async () => {
    const a = app();
    for (let i = 0; i < 20; i++) expect((await post(a, "/reserve", "{}", { "cf-connecting-ip": "203.0.113.7" })).status).toBe(401);
    expect((await post(a, "/reserve", "{}", { "cf-connecting-ip": "203.0.113.7" })).status).toBe(429);
  });

  it("a presenter code allows at most 100 requests a day", async () => {
    const llm = vi.fn(async () => ({ service: "basic-pension" }));
    const a = app({ interpret: llm, presenterCode: "stage", budget: memorySimBudget() });
    let llmCount = 0;
    for (let i = 0; i < 101; i++) {
      const r = await (await post(a, "/sim/interpret", JSON.stringify({ text: "기초연금" }), { "x-presenter-code": "stage", "cf-connecting-ip": "203.0.113.7" })).json();
      if (r.source === "llm") llmCount++;
    }
    expect(llmCount).toBe(100);
    const normal = await (await post(a, "/sim/interpret", JSON.stringify({ text: "기초연금" }), { "cf-connecting-ip": "198.51.100.1" })).json();
    expect(normal.source).toBe("llm");
  });
});

describe("CLI lock and record", () => {
  it("a lock held by a live pid is not taken even when it is old", async () => {
    const { withTaskLock } = await import("../packages/cli/src/task-files");
    const home = await mkdtemp(path.join(tmpdir(), "tm-lock-"));
    const dir = path.join(home, "t1");
    await mkdir(dir, { recursive: true });
    const lock = path.join(dir, "lock");
    await mkdir(lock);
    await writeFile(path.join(lock, "pid"), `${process.pid}\n`);
    const old = new Date(Date.now() - 3600_000);
    await utimes(lock, old, old);
    let entered = false;
    const attempt = withTaskLock(home, "t1", async () => { entered = true; }, { staleMs: 30, sleep: async () => { throw new Error("waiting"); } });
    await expect(attempt).rejects.toThrow("waiting");
    expect(entered).toBe(false);
    expect((await readFile(path.join(lock, "pid"), "utf8")).trim()).toBe(String(process.pid));
  });
});

describe("config and input checks", () => {
  it("an excessive clockSkewSec or maxLifetimeSec is CONFIG_INVALID", () => {
    const code = (fn: () => void) => { try { fn(); } catch (e) { return (e as TaskMandateError).code; } return undefined; };
    expect(code(() => assertVerifierConfig({ origin: SITE, clockSkewSec: 301 }))).toBe("CONFIG_INVALID");
    expect(code(() => assertVerifierConfig({ origin: SITE, maxLifetimeSec: 2592001 }))).toBe("CONFIG_INVALID");
    expect(code(() => assertVerifierConfig({ origin: SITE, clockSkewSec: 300, maxLifetimeSec: 2592000 }))).toBeUndefined();
  });

  it("issueMandate input checks", async () => {
    const p = await ed25519Jwk(), a = await ed25519Jwk();
    const base = { principalKey: p.priv, agentPublicKey: a.pub, audience: SITE, task: { type: "reserve" }, durationSec: 600, now: T0 };
    for (const bad of [{ audience: "https://court.example/path" }, { audience: "court.example" }, { durationSec: 0 }, { durationSec: 1.5 }, { durationSec: 2592001 }, { limits: { maxActions: 0 } }, { notBefore: new Date("x") }]) {
      const e = await issueMandate({ ...base, ...bad } as Parameters<typeof issueMandate>[0]).catch((x) => x);
      expect(e, JSON.stringify(bad)).toBeInstanceOf(TaskMandateError);
      expect(e.code).toBe("INPUT_INVALID");
    }
  });

  it("a different scheme is AUD_MISMATCH", async () => {
    const f = await fixture();
    const req = await f.sign(T0);
    const http = new Request(req.url.replace("https:", "http:"), req);
    expect(await verifyRequest(http, { origin: SITE }, route, memoryStore(), T0)).toMatchObject({ code: "AUD_MISMATCH" });
  });
});

describe("early body-length check", () => {
  it("a Content-Length over the cap is BODY_TOO_LARGE before the mandate is parsed", async () => {
    const req = new Request(`${SITE}/reserve`, { method: "POST", headers: { "agent-mandate": "garbage", "content-length": "99999" }, body: "{}" });
    expect(await verifyRequest(req, { origin: SITE, maxBodyBytes: 1024 }, route, memoryStore(), T0)).toMatchObject({ code: "BODY_TOO_LARGE" });
  });
  void sec;
});
