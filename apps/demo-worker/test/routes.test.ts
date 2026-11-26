import { createExecutionContext, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { issueMandate } from "@task-mandate/core";
import { digestKey } from "@task-mandate/core/internal";
import { signRequest } from "@task-mandate/node";
import { describe, expect, it } from "vitest";
import { loopbackOriginMismatch } from "../src/config";
import worker from "../src/index";

async function call(input: Request | string, init?: RequestInit): Promise<Response> {
  const request = typeof input === "string" ? new Request(input, init) : input;
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function ed25519(): Promise<{ priv: JsonWebKey; pub: JsonWebKey }> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  return { priv: (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey, pub: (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey };
}

describe("worker routes", () => {
  it("serves robots.txt and the noindex header", async () => {
    const robots = await call("http://127.0.0.1:8787/robots.txt");
    expect(robots.status).toBe(200);
    expect(robots.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(await robots.text()).toBe("User-agent: *\nDisallow: /\n");

    const home = await call("http://127.0.0.1:8787/");
    expect(home.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    const html = await home.text();
    expect(html).toContain("<title>과업 위임장</title>");
    expect(html).toContain('name="description"');
    expect(html).toContain('content="noindex, nofollow"');
    expect(html).toContain('name="theme-color"');
    expect(html).toContain("자리는 첫 예약 후 한 시간이 지나면 처음 상태로 돌아갑니다.");
    expect(html).toContain('href="/civil"');

    const slots = await call("http://127.0.0.1:8787/slots");
    expect(slots.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
  });

  it("returns 403 when the reset token is missing", async () => {
    const missing = await call("http://127.0.0.1:8787/reset", { method: "POST" });
    expect(missing.status).toBe(403);
    expect(missing.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");

    const wrong = await call("http://127.0.0.1:8787/reset", { method: "POST", headers: { "x-reset-token": "nope" } });
    expect(wrong.status).toBe(403);
  });

  it("reserves one facility with a mandate", async () => {
    const origin = "http://127.0.0.1:8787";
    const principal = await ed25519();
    const agent = await ed25519();
    const before = (await (await call(`${origin}/slots`)).json()) as { "court-3": number };
    const mandate = await issueMandate({ principalKey: principal.priv, agentPublicKey: agent.pub, audience: origin, task: { type: "reserve", resource: "court-3" }, limits: { maxActions: 1 }, durationSec: 600 });
    const signed = await signRequest(new Request(`${origin}/reserve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ facility: "court-3" }) }), { mandate, agentKey: agent.priv });
    const reserved = await call(signed);
    expect(reserved.status).toBe(200);
    const body = (await reserved.json()) as { ok: boolean; remaining: number };
    expect(body.ok).toBe(true);
    expect(body.remaining).toBe(before["court-3"] - 1);
  });

  it("records one civil application", async () => {
    const origin = "http://127.0.0.1:8787";
    const principal = await ed25519();
    const agent = await ed25519();
    const mandate = await issueMandate({ principalKey: principal.priv, agentPublicKey: agent.pub, audience: origin, task: { type: "apply", resource: "basic-pension" }, limits: { maxActions: 1 }, durationSec: 600 });
    const signed = await signRequest(new Request(`${origin}/civil/apply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ service: "basic-pension" }) }), { mandate, agentKey: agent.priv });
    const applied = await call(signed);
    expect(applied.status).toBe(200);
    expect(applied.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    const body = (await applied.json()) as { ok: boolean; service: string; receiptNo: string };
    expect(body.ok).toBe(true);
    expect(body.service).toBe("basic-pension");
    expect(body.receiptNo).toMatch(/^MO-[A-Z0-9]{8}$/);

    const log = await call(`${origin}/civil/log`);
    expect(log.status).toBe(200);
    const entries = ((await log.json()) as { entries: Array<Record<string, unknown>> }).entries;
    expect(entries[0]).toMatchObject({ status: 200, code: null, service: "basic-pension", task: "apply:basic-pension" });
  });

  it("does not respond to another host when ORIGIN is loopback", async () => {
    expect(loopbackOriginMismatch("http://localhost:8787", "203.0.113.5")).toBe(true);
    expect(loopbackOriginMismatch("http://127.0.0.1:8787", "localhost")).toBe(false);
    expect(loopbackOriginMismatch("https://task-mandate-demo.repairer5812.workers.dev", "203.0.113.5")).toBe(false);

    const leaked = await call("https://evil.example/");
    expect(leaked.status).toBe(500);
    expect(await leaked.text()).toBe("설정 오류");
    expect(leaked.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");

    const local = await call("http://localhost:8787/");
    expect(local.status).toBe(200);
    expect(await local.text()).toContain("과업 위임장");
  });

  it("returns 413 for a large body, and reset clears the log", async () => {
    const origin = "http://127.0.0.1:8787";
    const big = await call(`${origin}/civil/apply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ service: "basic-pension", pad: "x".repeat(2000) }) });
    expect(big.status).toBe(413);
    expect(big.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(await big.json()).toEqual({ error: "too-large" });

    const log = await call(`${origin}/civil/log`);
    expect(log.headers.get("cache-control")).toBe("no-store");
    const entries = ((await log.json()) as { entries: Array<Record<string, unknown>> }).entries;
    expect(entries[0]).toMatchObject({ status: 413, code: "too-large", service: null, task: null });
    expect(await civilRows("site")).toBe(0);
    expect(await civilRows("civil-log")).toBeGreaterThan(0);

    const reset = await call(`${origin}/reset`, { method: "POST", headers: { "x-reset-token": "test-reset" } });
    expect(reset.status).toBe(200);
    expect(await (await call(`${origin}/civil/log`)).json()).toEqual({ entries: [] });
    expect(await civilRows("civil-log")).toBe(0);
  });

  it("HEAD /civil is 200 with an empty body", async () => {
    const origin = "http://127.0.0.1:8787";
    const head = await call(`${origin}/civil`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(await head.text()).toBe("");

    const page = await call(`${origin}/civil`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("모의 민원 창구");
  });

  it("the 21st application from the same IP is 429, and reset accepts again", async () => {
    const origin = "http://127.0.0.1:8787";
    const ip = "203.0.113.21";
    const send = () => call(`${origin}/civil/apply`, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip }, body: JSON.stringify({ service: "basic-pension" }) });

    for (let i = 0; i < 20; i++) expect((await send()).status).toBe(401);
    const blocked = await send();
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    expect(await blocked.json()).toEqual({ error: "rate-limited" });

    const entries = ((await (await call(`${origin}/civil/log`)).json()) as { entries: Array<Record<string, unknown>> }).entries;
    expect(entries[0]).toMatchObject({ status: 401, code: "NO_MANDATE" });
    expect(entries.some((entry) => entry.status === 429 || entry.code === "rate-limited")).toBe(false);

    const keys = await limitKeys("civil-log");
    expect(keys).toContain(await digestKey(ip));
    expect(JSON.stringify(keys)).not.toContain(ip);
    expect(await limitRows("site")).toBe(0);
    expect(await alarmAt("civil-log")).toBeNull();

    const reset = await call(`${origin}/reset`, { method: "POST", headers: { "x-reset-token": "test-reset" } });
    expect(reset.status).toBe(200);
    expect(await limitRows("civil-log")).toBe(0);
    expect((await send()).status).toBe(401);
  });

  it("only 20 of 25 concurrent applications from the same IP pass", async () => {
    const origin = "http://127.0.0.1:8787";
    const ip = "203.0.113.25";
    const responses = await Promise.all(Array.from({ length: 25 }, () => call(`${origin}/civil/apply`, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip }, body: JSON.stringify({ service: "basic-pension" }) })));
    const statuses = await Promise.all(responses.map(async (response) => response.status));
    expect(statuses.filter((status) => status !== 429)).toHaveLength(20);
    expect(statuses.filter((status) => status === 429)).toHaveLength(5);
  });
});

function civilObject(name: string) {
  return env.MANDATE_STORE.get(env.MANDATE_STORE.idFromName(name));
}

function civilRows(name: string): Promise<number> {
  return runInDurableObject(civilObject(name), (_instance, state) => {
    const rows = state.storage.sql.exec("SELECT COUNT(*) AS n FROM civil_log").toArray();
    return Number(rows[0]?.n ?? 0);
  });
}

function limitRows(name: string): Promise<number> {
  return runInDurableObject(civilObject(name), (_instance, state) => {
    const rows = state.storage.sql.exec("SELECT COUNT(*) AS n FROM civil_limit").toArray();
    return Number(rows[0]?.n ?? 0);
  });
}

function limitKeys(name: string): Promise<string[]> {
  return runInDurableObject(civilObject(name), (_instance, state) =>
    state.storage.sql
      .exec("SELECT client_key FROM civil_limit")
      .toArray()
      .map((row) => String(row.client_key)),
  );
}

function alarmAt(name: string): Promise<number | null> {
  return runInDurableObject(civilObject(name), (_instance, state) => state.storage.getAlarm());
}
