import { readdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Decision, decodeMandateUnverified, issueMandate, PROFILE, type RoutePolicy, thumbprint, type VerifierConfig } from "@task-mandate/core";
import { CLAIM, COMPONENT, signatureComponents } from "@task-mandate/core/internal";
import { signRequest } from "@task-mandate/node";
import { signComponents } from "../packages/agent/src/sign.js";
import { bodyTooLargeVector } from "./body-vector.js";
import { limitVectors } from "./limit-vectors.js";
import { personVectors } from "./person-vectors.js";
import { withRandom } from "./seeded-random.js";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIR = path.join(ROOT, "vectors");
const FIXED = new Date("2026-12-01T00:00:00.000Z");
const SITE = "https://court.example";

interface Keys {
  principal: JsonWebKey;
  agent: JsonWebKey;
  attacker: JsonWebKey;
  idp: JsonWebKey;
  agentKeyId: string;
}

interface Step {
  request: { method: string; url: string; headers: Record<string, string>; body?: string };
  expected: Decision;
}

interface VectorFile {
  name: string;
  now: string;
  config: VerifierConfig;
  route: RoutePolicy;
  steps: Step[];
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return Object.fromEntries(entries.map(([key, item]) => [key, stable(item)]));
  }
  return value;
}

function reserve(): Request {
  return new Request(`${SITE}/reserve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ facility: "court-3" }) });
}

async function dump(req: Request): Promise<Step["request"]> {
  const headers: Record<string, string> = {};
  req.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const body = req.body ? await req.text() : undefined;
  return { method: req.method, url: req.url, headers, ...(body ? { body } : {}) };
}

function file(name: string, config: VerifierConfig, route: RoutePolicy, steps: Step[]): VectorFile {
  return { name, now: FIXED.toISOString(), config, route, steps };
}

function expectedAllow(token: string, agentKeyId: string, route: RoutePolicy): Extract<Decision, { decision: "allow" }> & { actionConsumed: boolean } {
  const decoded = decodeMandateUnverified(token);
  const payload = decoded?.payload;
  const task = payload?.[CLAIM.task];
  if (!payload || !task || typeof task !== "object") throw new Error("could not parse the mandate");
  const principal = payload[CLAIM.sub];
  const mandateId = payload[CLAIM.jti];
  if (typeof principal !== "string" || typeof mandateId !== "string") throw new Error("mandate is missing fields");
  const tid = payload[CLAIM.tid];
  const taskId = typeof tid === "string" && tid !== "" ? tid : mandateId;
  const actionConsumed = route.requireTask !== undefined && payload[CLAIM.limits] !== undefined;
  const person = personFrom(payload[CLAIM.pa]);
  return { decision: "allow", principal, agentKeyId, mandateId, taskId, task: task as Decision extends { task: infer T } ? T : never, ...(person ? { person } : {}), actionConsumed, refund: async () => {} };
}

function personFrom(value: unknown): { iss: string; sub: string } | undefined {
  if (typeof value !== "string" || value === "") return undefined;
  const part = value.split(".")[1];
  if (!part) return undefined;
  const claims = JSON.parse(Buffer.from(part, "base64url").toString()) as { iss?: unknown; sub?: unknown };
  if (typeof claims.iss !== "string" || typeof claims.sub !== "string") return undefined;
  return { iss: claims.iss, sub: claims.sub };
}

async function issue(keys: Keys, over: Partial<Parameters<typeof issueMandate>[0]> = {}): Promise<string> {
  return issueMandate({ principalKey: keys.principal, agentPublicKey: keys.agent, audience: SITE, task: { type: "reserve", resource: "court-3" }, limits: { maxActions: 2 }, durationSec: 1800, now: FIXED, ...over });
}

async function build(keys: Keys): Promise<VectorFile[]> {
  const route = { requireTask: { type: "reserve", resource: "court-3" } };
  const config = { origin: SITE };
  const out: VectorFile[] = [];

  out.push(
    await withRandom("allow", async () => {
      const token = await issue(keys);
      const req = await signRequest(reserve(), { mandate: token, agentKey: keys.agent, now: FIXED });
      return file("allow", config, route, [{ request: await dump(req), expected: expectedAllow(token, keys.agentKeyId, route) }]);
    }),
  );

  out.push(
    await withRandom("allow-tid", async () => {
      const token = await issue(keys, { taskId: "task-1" });
      const req = await signRequest(reserve(), { mandate: token, agentKey: keys.agent, now: FIXED });
      return file("allow-tid", config, route, [{ request: await dump(req), expected: expectedAllow(token, keys.agentKeyId, route) }]);
    }),
  );

  out.push(file("no-mandate", { ...config, onNoMandate: "challenge" }, route, [{ request: await dump(reserve()), expected: { decision: "challenge", code: "NO_MANDATE" } }]));

  out.push(
    file("mandate-malformed", config, route, [{ request: await dump(new Request(`${SITE}/reserve`, { method: "POST", headers: { "content-type": "application/json", "agent-mandate": "not-a-mandate" }, body: JSON.stringify({ facility: "court-3" }) })), expected: { decision: "deny", code: "MANDATE_MALFORMED" } }]),
  );

  out.push(
    await withRandom("mandate-sig-invalid", async () => {
      const token = await issue(keys);
      const [h, p, s] = token.split("~")[0]!.split(".");
      const claims = JSON.parse(Buffer.from(p!, "base64url").toString()) as { task: { resource: string } };
      claims.task.resource = "court-9";
      const forged = `${h}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${s}~`;
      const req = await signRequest(reserve(), { mandate: forged, agentKey: keys.agent, now: FIXED });
      return file("mandate-sig-invalid", config, route, [{ request: await dump(req), expected: { decision: "deny", code: "MANDATE_SIG_INVALID" } }]);
    }),
  );

  out.push(
    await withRandom("issuer-not-trusted", async () => {
      const token = await issue(keys);
      const req = await signRequest(reserve(), { mandate: token, agentKey: keys.agent, now: FIXED });
      return file("issuer-not-trusted", { ...config, trustedIssuers: ["urn:jwk-thumbprint:sha-256:not-the-principal"] }, route, [{ request: await dump(req), expected: { decision: "deny", code: "ISSUER_NOT_TRUSTED" } }]);
    }),
  );

  out.push(
    await withRandom("aud-mismatch", async () => {
      const token = await issue(keys, { audience: "https://other.example" });
      const req = await signRequest(reserve(), { mandate: token, agentKey: keys.agent, now: FIXED });
      return file("aud-mismatch", config, route, [{ request: await dump(req), expected: { decision: "deny", code: "AUD_MISMATCH" } }]);
    }),
  );

  out.push(
    await withRandom("not-yet-valid", async () => {
      const token = await issue(keys, { notBefore: new Date(FIXED.getTime() + 600_000) });
      const req = await signRequest(reserve(), { mandate: token, agentKey: keys.agent, now: FIXED });
      return file("not-yet-valid", config, route, [{ request: await dump(req), expected: { decision: "deny", code: "NOT_YET_VALID" } }]);
    }),
  );

  out.push(
    await withRandom("expired", async () => {
      const issuedAt = new Date(FIXED.getTime() - 2 * 3600 * 1000);
      const token = await issue(keys, { now: issuedAt, durationSec: 60 });
      const req = await signRequest(reserve(), { mandate: token, agentKey: keys.agent, now: FIXED });
      return file("expired", config, route, [{ request: await dump(req), expected: { decision: "deny", code: "EXPIRED" } }]);
    }),
  );

  out.push(
    await withRandom("lifetime-too-long", async () => {
      const token = await issue(keys, { durationSec: 120 });
      const req = await signRequest(reserve(), { mandate: token, agentKey: keys.agent, now: FIXED });
      return file("lifetime-too-long", { ...config, maxLifetimeSec: 60 }, route, [{ request: await dump(req), expected: { decision: "deny", code: "LIFETIME_TOO_LONG" } }]);
    }),
  );

  out.push(
    await withRandom("sig-missing", async () => {
      const token = await issue(keys);
      const req = new Request(`${SITE}/reserve`, { method: "POST", headers: { "content-type": "application/json", [PROFILE.header]: token }, body: JSON.stringify({ facility: "court-3" }) });
      return file("sig-missing", config, route, [{ request: await dump(req), expected: { decision: "deny", code: "SIG_MISSING" } }]);
    }),
  );

  out.push(
    await withRandom("key-mismatch", async () => {
      const token = await issue(keys);
      const req = await signRequest(reserve(), { mandate: token, agentKey: keys.attacker, now: FIXED });
      return file("key-mismatch", config, route, [{ request: await dump(req), expected: { decision: "deny", code: "KEY_MISMATCH" } }]);
    }),
  );

  out.push(
    await withRandom("sig-invalid", async () => {
      const token = await issue(keys);
      const req = await signRequest(reserve(), { mandate: token, agentKey: keys.agent, now: FIXED });
      const headers = new Headers(req.headers);
      const value = headers.get("signature") ?? "";
      headers.set("signature", value.slice(0, -2) + (value.at(-2) === "A" ? "B" : "A") + value.slice(-1));
      const body = await req.clone().arrayBuffer();
      const flipped = new Request(req.url, { method: req.method, headers, body });
      return file("sig-invalid", config, route, [{ request: await dump(flipped), expected: { decision: "deny", code: "SIG_INVALID" } }]);
    }),
  );

  out.push(
    await withRandom("sig-expired", async () => {
      const token = await issue(keys);
      const created = new Date(FIXED.getTime() - 600_000);
      const req = await signRequest(reserve(), { mandate: token, agentKey: keys.agent, now: created });
      return file("sig-expired", config, route, [{ request: await dump(req), expected: { decision: "deny", code: "SIG_INVALID" } }]);
    }),
  );

  out.push(
    await withRandom("sig-uncovered", async () => {
      const token = await issue(keys);
      const req = await signComponents(reserve(), { mandate: token, agentKey: keys.agent, created: FIXED, expires: new Date(FIXED.getTime() + 300_000), components: [PROFILE.header] });
      return file("sig-uncovered", config, route, [{ request: await dump(req), expected: { decision: "deny", code: "SIG_INVALID" } }]);
    }),
  );

  out.push(
    await withRandom("sig-missing-components", async () => {
      const token = await issue(keys);
      const req = await signComponents(reserve(), { mandate: token, agentKey: keys.agent, created: FIXED, expires: new Date(FIXED.getTime() + 300_000), components: [COMPONENT.authority, COMPONENT.mandate, COMPONENT.contentDigest] });
      return file("sig-missing-components", config, route, [{ request: await dump(req), expected: { decision: "deny", code: "SIG_INVALID" } }]);
    }),
  );

  out.push(
    await withRandom("content-digest-missing", async () => {
      const token = await issue(keys);
      const req = await signComponents(reserve(), { mandate: token, agentKey: keys.agent, created: FIXED, expires: new Date(FIXED.getTime() + 300_000), components: signatureComponents(false) });
      return file("content-digest-missing", config, route, [{ request: await dump(req), expected: { decision: "deny", code: "SIG_INVALID" } }]);
    }),
  );

  out.push(
    await withRandom("content-digest-mismatch", async () => {
      const token = await issue(keys);
      const req = await signRequest(reserve(), { mandate: token, agentKey: keys.agent, now: FIXED });
      const dumped = await dump(req);
      dumped.body = JSON.stringify({ facility: "court-3", note: "x" });
      return file("content-digest-mismatch", config, route, [{ request: dumped, expected: { decision: "deny", code: "SIG_INVALID" } }]);
    }),
  );

  out.push(
    await withRandom("host-mismatch", async () => {
      const token = await issue(keys);
      const req = await signRequest(new Request("https://evil.example/reserve", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ facility: "court-3" }) }), { mandate: token, agentKey: keys.agent, now: FIXED });
      return file("host-mismatch", config, route, [{ request: await dump(req), expected: { decision: "deny", code: "AUD_MISMATCH" } }]);
    }),
  );

  out.push(
    await withRandom("replay", async () => {
      const token = await issue(keys, { limits: { maxActions: 5 } });
      const req = await signRequest(reserve(), { mandate: token, agentKey: keys.agent, now: FIXED });
      const dumped = await dump(req);
      return file("replay", config, route, [
        { request: dumped, expected: expectedAllow(token, keys.agentKeyId, route) },
        { request: dumped, expected: { decision: "deny", code: "REPLAY" } },
      ]);
    }),
  );

  out.push(
    await withRandom("task-not-allowed", async () => {
      const token = await issue(keys, { task: { type: "lookup", resource: "court-3" } });
      const req = await signRequest(reserve(), { mandate: token, agentKey: keys.agent, now: FIXED });
      return file("task-not-allowed", config, route, [{ request: await dump(req), expected: { decision: "deny", code: "TASK_NOT_ALLOWED" } }]);
    }),
  );

  out.push(
    await withRandom("allow-tend", async () => {
      const token = await issue(keys, { taskEnd: new Date(FIXED.getTime() + 7200 * 1000) });
      const req = await signRequest(reserve(), { mandate: token, agentKey: keys.agent, now: FIXED });
      return file("allow-tend", config, route, [{ request: await dump(req), expected: expectedAllow(token, keys.agentKeyId, route) }]);
    }),
  );

  out.push(
    await withRandom("tend-before-exp", async () => {
      const token = await issue(keys);
      const [h, p, s] = token.split("~")[0]!.split(".");
      const claims = JSON.parse(Buffer.from(p!, "base64url").toString()) as Record<string, unknown>;
      const exp = claims[CLAIM.exp];
      if (typeof exp !== "number") throw new Error("exp is missing");
      claims[CLAIM.tend] = exp - 1;
      const forged = `${h}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${s}~`;
      const req = await signRequest(reserve(), { mandate: forged, agentKey: keys.agent, now: FIXED });
      return file("tend-before-exp", config, route, [{ request: await dump(req), expected: { decision: "deny", code: "MANDATE_MALFORMED" } }]);
    }),
  );

  out.push(
    await withRandom("limit-exceeded", async () => {
      const token = await issue(keys, { limits: { maxActions: 1 } });
      const first = await signRequest(reserve(), { mandate: token, agentKey: keys.agent, now: FIXED });
      const second = await signRequest(reserve(), { mandate: token, agentKey: keys.agent, now: FIXED });
      const limitRoute = { requireTask: { type: "reserve" } };
      return file("limit-exceeded", config, limitRoute, [
        { request: await dump(first), expected: expectedAllow(token, keys.agentKeyId, limitRoute) },
        { request: await dump(second), expected: { decision: "deny", code: "LIMIT_EXCEEDED" } },
      ]);
    }),
  );

  out.push(await bodyTooLargeVector({ keys, site: SITE, now: FIXED, withRandom, file, issue: () => issue(keys), dump }));
  out.push(...(await personVectors({ keys, site: SITE, now: FIXED, withRandom, file, issue: (over) => issue(keys, over), reserve, dump, expectedAllow })));
  out.push(...(await limitVectors({ keys, site: SITE, now: FIXED, withRandom, file, issue: (over) => issue(keys, over), reserve, dump })));

  return out;
}

async function main(): Promise<void> {
  const raw = JSON.parse(await readFile(path.join(DIR, "keys.json"), "utf8")) as { principal: JsonWebKey; agent: JsonWebKey; attacker: JsonWebKey; idp: JsonWebKey };
  const keys: Keys = { ...raw, agentKeyId: await thumbprint(raw.agent) };
  const vectors = await build(keys);
  const names = new Set(["keys.json"]);
  for (const vector of vectors) {
    const filename = `${vector.name}.json`;
    names.add(filename);
    await writeFile(path.join(DIR, filename), `${JSON.stringify(stable(vector), null, 2)}\n`);
  }
  for (const entry of await readdir(DIR)) {
    if (entry.endsWith(".json") && !names.has(entry)) await unlink(path.join(DIR, entry));
  }
}

await main();
