// Acceptance tests for the mock civil-service application desk. Do not edit to make a change pass.
import { describe, it, expect, beforeEach } from "vitest";
import { issueMandate, memoryStore } from "@task-mandate/core";
import { signRequest } from "@task-mandate/node";
import { createApp, memoryCivilLog, CIVIL_SERVICES } from "../apps/demo-site/src/app";

const SITE = "https://court.example";
const NOW = new Date("2026-12-01T00:00:00Z");
const now = () => NOW;

async function ed25519Jwk() {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  return { priv: await crypto.subtle.exportKey("jwk", kp.privateKey), pub: await crypto.subtle.exportKey("jwk", kp.publicKey) };
}

let principal: Awaited<ReturnType<typeof ed25519Jwk>>;
let agent: Awaited<ReturnType<typeof ed25519Jwk>>;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  principal = await ed25519Jwk();
  agent = await ed25519Jwk();
  app = createApp({ origin: SITE, store: memoryStore({ now }), seats: { "court-3": 5 }, civilLog: memoryCivilLog(), now });
});

function mandate(task: { type: string; resource?: string }, maxActions = 1) {
  return issueMandate({
    principalKey: principal.priv,
    agentPublicKey: agent.pub,
    audience: SITE,
    task,
    limits: { maxActions },
    durationSec: 600,
    now: NOW,
  });
}

async function post(path: string, body: unknown, m?: string) {
  const req = new Request(`${SITE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return app.request(m ? await signRequest(req, { mandate: m, agentKey: agent.priv, now: NOW }) : req);
}

const apply = (service: unknown, m?: string) => post("/civil/apply", { service }, m);

async function log() {
  const res = await app.request(`${SITE}/civil/log`);
  expect(res.status).toBe(200);
  return (await res.json()).entries as Array<Record<string, unknown>>;
}

describe("mock civil-service list", () => {
  it("the list is public and in a fixed order", async () => {
    const res = await app.request(`${SITE}/civil/services`);
    expect(res.status).toBe(200);
    const { services } = await res.json();
    expect(services.map((s: { id: string }) => s.id)).toEqual(["basic-pension", "resident-copy", "disability-taxi"]);
    for (const s of services) expect(s.title).toContain("모의");
    expect(CIVIL_SERVICES.map((s) => s.id)).toEqual(services.map((s: { id: string }) => s.id));
  });
});

describe("mock civil-service apply", () => {
  it("a matching task and service returns a receipt id", async () => {
    const res = await apply("basic-pension", await mandate({ type: "apply", resource: "basic-pension" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, service: "basic-pension" });
    expect(body.title).toContain("기초연금");
    expect(body.receiptNo).toMatch(/^MO-[A-Z0-9]{8}$/);
  });

  it("applying without a mandate is 401 NO_MANDATE", async () => {
    const res = await apply("basic-pension");
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("NO_MANDATE");
  });

  it("a mandate for a different service cannot apply", async () => {
    const res = await apply("resident-copy", await mandate({ type: "apply", resource: "basic-pension" }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("TASK_NOT_ALLOWED");
  });

  it("a reservation mandate cannot apply, and an apply mandate cannot reserve", async () => {
    const r1 = await apply("basic-pension", await mandate({ type: "reserve", resource: "basic-pension" }));
    expect((await r1.json()).code).toBe("TASK_NOT_ALLOWED");
    const r2 = await post("/reserve", { facility: "court-3" }, await mandate({ type: "apply", resource: "court-3" }));
    expect((await r2.json()).code).toBe("TASK_NOT_ALLOWED");
  });

  it("a second application with a one-action mandate is LIMIT_EXCEEDED", async () => {
    const m = await mandate({ type: "apply", resource: "basic-pension" });
    expect((await apply("basic-pension", m)).status).toBe(200);
    expect((await (await apply("basic-pension", m)).json()).code).toBe("LIMIT_EXCEEDED");
  });

  it("an unknown service id is 404, including an inherited property name", async () => {
    expect((await apply("passport", await mandate({ type: "apply", resource: "passport" }))).status).toBe(404);
    expect((await apply("toString", await mandate({ type: "apply", resource: "toString" }))).status).toBe(404);
  });

  it("a missing, non-string, or over-64-unit service name is 400", async () => {
    const long = "s".repeat(65);
    expect((await post("/civil/apply", {}, await mandate({ type: "apply", resource: "basic-pension" }))).status).toBe(400);
    expect((await apply(3, await mandate({ type: "apply", resource: "basic-pension" }))).status).toBe(400);
    expect((await apply(long, await mandate({ type: "apply", resource: long }))).status).toBe(400);
  });
});

describe("verification log", () => {
  it("each application adds one line, newest first", async () => {
    await apply("basic-pension");
    await apply("basic-pension", await mandate({ type: "apply", resource: "basic-pension" }));
    const entries = await log();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ at: NOW.toISOString(), status: 200, code: null, service: "basic-pension", task: "apply:basic-pension" });
    expect(entries[1]).toEqual({ at: NOW.toISOString(), status: 401, code: "NO_MANDATE", service: "basic-pension", task: null });
  });

  it("an application the handler rejects keeps the response code", async () => {
    await apply("resident-copy", await mandate({ type: "apply", resource: "basic-pension" }));
    const [entry] = await log();
    expect(entry).toMatchObject({ status: 403, code: "TASK_NOT_ALLOWED", service: "resident-copy" });
  });

  it("400 and 404 keep the response error as the code", async () => {
    await apply("passport", await mandate({ type: "apply", resource: "passport" }));
    await apply(3, await mandate({ type: "apply", resource: "basic-pension" }));
    const entries = await log();
    expect(entries[0]).toMatchObject({ status: 400, code: "bad-request", service: null });
    expect(entries[1]).toMatchObject({ status: 404, code: "not-found", service: "passport" });
  });

  it("only the latest 50 lines are kept", async () => {
    for (let i = 0; i < 55; i++) await apply("basic-pension");
    expect(await log()).toHaveLength(50);
  });

  it("the log does not store the mandate, signature, or keys", async () => {
    const m = await mandate({ type: "apply", resource: "basic-pension" });
    await apply("basic-pension", m);
    const text = JSON.stringify(await log());
    expect(text).not.toContain(m.slice(0, 40));
    expect(text).not.toContain(String(agent.pub.x));
    expect(text).not.toContain(String(principal.pub.x));
    expect(text.toLowerCase()).not.toContain("signature");
  });

  it("the reservation route is not written to the civil log", async () => {
    await post("/reserve", { facility: "court-3" });
    expect(await log()).toHaveLength(0);
  });
});
