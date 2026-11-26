// Stop renewal. The agent requests every second with the latest mandate until the first EXPIRED, and that wait is measured.
import { parseArgs } from "node:util";
import { DEFAULT_CLOCK_SKEW_SEC, issueMandate, type LeasePlan, memoryStore } from "@task-mandate/core";
import { createApp } from "@task-mandate/demo-site";
import { Renewer, signRequest } from "@task-mandate/node";
import { attestFor, issuerOf, readIdp } from "./idp";
import { ed25519, type KeyPair } from "./keys";
import { machine, round, writeResult } from "./stats";

const SITE = "https://bench.example";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const { values } = parseArgs({ options: { chunk: { type: "string" }, trials: { type: "string", default: "5" }, url: { type: "string" }, "reset-token": { type: "string" }, idp: { type: "string" } } });

const chunkSec = Number(values.chunk);
const trials = Number(values.trials);
const remote = values.url?.replace(/\/$/, "");
if (!Number.isInteger(chunkSec) || chunkSec < 1) throw new Error("--chunk must be an integer of at least 1 second");
if (!Number.isInteger(trials) || trials < 1) throw new Error("trials must be an integer of at least 1");
if (!values.idp) throw new Error("--idp is required");
if (remote && !values["reset-token"]) throw new Error("--reset-token is required when --url is set");
const idp = await readIdp(values.idp);

const boundSec = chunkSec + DEFAULT_CLOCK_SKEW_SEC;

async function issueChunk(principal: KeyPair, agent: KeyPair, plan: LeasePlan, window: { nbf: Date; exp: Date }, audience: string, personAttestation: string): Promise<string> {
  const nbfSec = Math.floor(window.nbf.getTime() / 1000);
  const expSec = Math.floor(window.exp.getTime() / 1000);
  return issueMandate({
    principalKey: principal.priv,
    agentPublicKey: agent.pub,
    audience,
    task: { type: "reserve", resource: "court-3" },
    limits: { maxActions: 1_000_000 },
    taskId: plan.taskId,
    taskBegin: plan.start,
    taskEnd: plan.end,
    durationSec: Math.max(1, expSec - nbfSec),
    notBefore: new Date(nbfSec * 1000),
    now: new Date(nbfSec * 1000),
    personAttestation,
  });
}

async function attestation(principal: KeyPair, audience: string, personId: string, start: Date, end: Date): Promise<string> {
  const spanSec = Math.ceil((end.getTime() - start.getTime()) / 1000) + 120;
  return attestFor(idp, { personId, audience, principalPublicKey: principal.pub, durationSec: spanSec, now: start });
}

async function ask(mandate: string, agent: KeyPair, now: Date, audience: string, send: (request: Request) => Promise<Response>): Promise<string | undefined> {
  const signed = await signRequest(new Request(`${audience}/reserve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ facility: "court-3" }) }), { mandate, agentKey: agent.priv, now });
  const response = await send(signed);
  const body = (await response.json()) as { code?: string };
  return body.code;
}

async function trialLocal(): Promise<{ stopOffsetSec: number; latencySec: number }> {
  const start = new Date("2026-12-01T00:00:00Z");
  const end = new Date(start.getTime() + (chunkSec * 4 + boundSec + 5) * 1000);
  let clock = new Date(start.getTime());
  const plan: LeasePlan = { taskId: crypto.randomUUID(), start, end, chunkSec };
  const principal = await ed25519();
  const agent = await ed25519();
  const personId = `stop-${crypto.randomUUID()}`;
  const pa = await attestation(principal, SITE, personId, start, end);
  const app = createApp({ origin: SITE, store: memoryStore({ now: () => clock }), seats: { "court-3": 1_000_000 }, now: () => clock, personIssuers: [issuerOf(idp)], requirePerson: true, onePerPerson: true, minSwitchSec: 600 });
  const renewer = new Renewer({ plan, now: () => clock, issue: (window) => issueChunk(principal, agent, plan, window, SITE, pa), write: async () => {} });
  if ((await renewer.tick()) !== "issued") throw new Error("failed to issue the first chunk");
  const stopOffsetSec = Math.floor(Math.random() * (chunkSec + 1));
  let stoppedAt: number | undefined;
  for (let sec = 0; sec <= boundSec + chunkSec + 5; sec++) {
    clock = new Date(start.getTime() + sec * 1000);
    if (stoppedAt === undefined && sec >= stopOffsetSec) {
      renewer.stop();
      stoppedAt = sec;
    }
    await renewer.tick();
    const mandate = renewer.current();
    if (!mandate || stoppedAt === undefined) continue;
    const code = await ask(mandate, agent, clock, SITE, (request) => Promise.resolve(app.request(request)));
    if (code === "EXPIRED") return { stopOffsetSec, latencySec: sec - stoppedAt };
  }
  throw new Error("EXPIRED did not appear");
}

async function trialRemote(origin: string, token: string): Promise<{ stopOffsetSec: number; latencySec: number }> {
  const reset = await fetch(new URL("/reset", origin), { method: "POST", headers: { "x-reset-token": token } });
  if (reset.status !== 200) throw new Error(`reset failed: ${reset.status}`);
  const start = new Date();
  const end = new Date(start.getTime() + (chunkSec * 4 + boundSec + 5) * 1000);
  const plan: LeasePlan = { taskId: crypto.randomUUID(), start, end, chunkSec };
  const principal = await ed25519();
  const agent = await ed25519();
  const personId = `stop-${crypto.randomUUID()}`;
  const pa = await attestation(principal, origin, personId, start, end);
  const renewer = new Renewer({ plan, issue: (window) => issueChunk(principal, agent, plan, window, origin, pa), write: async () => {} });
  if ((await renewer.tick()) !== "issued") throw new Error("failed to issue the first chunk");
  const stopOffsetSec = Math.random() * chunkSec;
  const begun = performance.now();
  let stoppedAt: number | undefined;
  while (performance.now() - begun < (chunkSec * 2 + boundSec + 5) * 1000) {
    const elapsed = (performance.now() - begun) / 1000;
    if (stoppedAt === undefined && elapsed >= stopOffsetSec) {
      renewer.stop();
      stoppedAt = performance.now();
    }
    await renewer.tick();
    const mandate = renewer.current();
    if (mandate && stoppedAt !== undefined) {
      const code = await ask(mandate, agent, new Date(), origin, (request) => fetch(request));
      if (code === "EXPIRED") return { stopOffsetSec: round(stopOffsetSec), latencySec: round((performance.now() - stoppedAt) / 1000) };
    }
    await sleep(1000);
  }
  throw new Error("EXPIRED did not appear");
}

const samples: { stopOffsetSec: number; latencySec: number }[] = [];
for (let i = 0; i < trials; i++) {
  const sample = remote ? await trialRemote(remote, values["reset-token"]!) : await trialLocal();
  if (sample.latencySec > boundSec + 1) throw new Error(`above the bound: ${sample.latencySec} > ${boundSec}+1`);
  samples.push(sample);
}

const latencies = samples.map((sample) => sample.latencySec);
const path = writeResult("stop-latency", {
  ...machine(),
  iterations: trials,
  target: remote ?? "local",
  colo: null,
  chunkSec,
  clockSkewSec: DEFAULT_CLOCK_SKEW_SEC,
  boundSec,
  unit: "s",
  note: "The local run advances a fake clock by 1 second. Requests are also 1 second apart, so an observation can be up to 1 second above the theoretical bound. The bound is chunk + clockSkewSec.",
  samples,
  maxLatencySec: round(Math.max(...latencies)),
  meanLatencySec: round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length),
});

console.log(path);
console.log(JSON.stringify({ boundSec, samples }, null, 2));
