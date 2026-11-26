// Repeat only verifyRequest in the same process. Signatures are created before measurement.
import { parseArgs } from "node:util";
import { issueMandate, issuePersonAttestation, memoryStore, type VerifierConfig, verifyRequest } from "@task-mandate/core";
import { signRequest } from "@task-mandate/node";
import { ed25519, pubOnly } from "./keys";
import { machine, summarize, writeResult } from "./stats";

const SITE = "https://bench.example";
const IDP = "https://idp.example";
const FIXED = new Date("2026-12-01T00:00:00Z");

const { values } = parseArgs({ options: { iterations: { type: "string", default: "5000" } } });

const iterations = Number(values.iterations);
if (!Number.isInteger(iterations) || iterations < 1) throw new Error("iterations must be an integer of at least 1");

async function signed(mandate: string, agentKey: JsonWebKey): Promise<Request> {
  return signRequest(new Request(`${SITE}/reserve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ facility: "court-3" }) }), { mandate, agentKey, now: FIXED });
}

async function measure(label: string, config: VerifierConfig, mandate: string, agentKey: JsonWebKey): Promise<ReturnType<typeof summarize>> {
  const requests: Request[] = [];
  for (let i = 0; i < iterations; i++) requests.push(await signed(mandate, agentKey));
  const store = memoryStore({ now: () => FIXED });
  const samples: number[] = [];
  for (const request of requests) {
    const started = performance.now();
    const decision = await verifyRequest(request, config, { requireTask: { type: "reserve" } }, store, FIXED);
    samples.push(performance.now() - started);
    if (decision.decision !== "allow") throw new Error(`${label}: ${decision.code}`);
  }
  return summarize(samples);
}

const principal = await ed25519();
const agent = await ed25519();
const idp = await ed25519();
const attestation = await issuePersonAttestation({ idpKey: idp.priv, idpIssuer: IDP, secret: "bench-only-pairwise-secret", personId: "person-1", audience: SITE, principalPublicKey: principal.pub, durationSec: 86400 * 30, now: FIXED });

const base = { principalKey: principal.priv, agentPublicKey: agent.pub, audience: SITE, task: { type: "reserve", resource: "court-3" }, limits: { maxActions: iterations }, durationSec: 3600, now: FIXED };

const mandateOnly = await issueMandate(base);
const withPerson = await issueMandate({ ...base, personAttestation: attestation, taskId: "bench-task", taskBegin: FIXED, taskEnd: new Date(FIXED.getTime() + 7 * 86400_000) });
const issuers = [{ iss: IDP, jwks: [pubOnly(idp.pub)] }];

const cases = {
  mandate: await measure("mandate only", { origin: SITE }, mandateOnly, agent.priv),
  person: await measure("person attestation", { origin: SITE, personIssuers: issuers, requirePerson: true }, withPerson, agent.priv),
  onePerPerson: await measure("one per person", { origin: SITE, personIssuers: issuers, requirePerson: true, onePerPerson: true, minSwitchSec: 600 }, withPerson, agent.priv),
};

const path = writeResult("verify-local", { ...machine(), iterations, target: "local", colo: null, unit: "ms", note: "Signatures are created before measurement. Each request has its own nonce. The time is fixed.", cases });

console.log(path);
console.log(JSON.stringify(cases, null, 2));
