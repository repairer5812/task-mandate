// Round trip time of GET /slots and a mandate POST /reserve. The difference approximates time in verification and the store.
import { parseArgs } from "node:util";
import { issueMandate } from "@task-mandate/core";
import { signRequest } from "@task-mandate/node";
import { attestFor, readIdp } from "./idp";
import { ed25519 } from "./keys";
import { machine, percentile, round, writeResult } from "./stats";

const { values } = parseArgs({ options: { url: { type: "string" }, n: { type: "string", default: "200" }, interval: { type: "string", default: "50" }, "reset-token": { type: "string" }, idp: { type: "string" } } });

const url = values.url?.replace(/\/$/, "");
const n = Number(values.n);
const intervalMs = Number(values.interval);
const resetToken = values["reset-token"];
const idpFile = values.idp;
if (!url) throw new Error("--url is required");
if (!resetToken) throw new Error("--reset-token is required");
if (!idpFile) throw new Error("--idp is required");
if (!Number.isInteger(n) || n < 1) throw new Error("n must be an integer of at least 1");
if (!Number.isFinite(intervalMs) || intervalMs < 0) throw new Error("interval is invalid");

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function coloOf(response: Response): string | null {
  const ray = response.headers.get("cf-ray");
  if (!ray) return null;
  const code = ray.split("-")[1];
  return code || null;
}

async function timed(run: () => Promise<Response>): Promise<{ ms: number; status: number; colo: string | null }> {
  const started = performance.now();
  const response = await run();
  await response.arrayBuffer();
  return { ms: performance.now() - started, status: response.status, colo: coloOf(response) };
}

const reset = await fetch(new URL("/reset", url), { method: "POST", headers: { "x-reset-token": resetToken } });
if (reset.status !== 200) throw new Error(`reset failed: ${reset.status} ${await reset.text()}`);

const principal = await ed25519();
const agent = await ed25519();
const idp = await readIdp(idpFile);
const now = new Date();
const personId = `edge-${crypto.randomUUID()}`;
const mandate = await issueMandate({
  principalKey: principal.priv,
  agentPublicKey: agent.pub,
  audience: url,
  task: { type: "reserve", resource: "court-3" },
  limits: { maxActions: n },
  durationSec: 3600,
  now,
  taskId: `edge-task-${crypto.randomUUID()}`,
  taskBegin: now,
  taskEnd: new Date(now.getTime() + 3600_000),
  personAttestation: await attestFor(idp, { personId, audience: url, principalPublicKey: principal.pub, durationSec: 7200, now }),
});

const slots: number[] = [];
const reserve: number[] = [];
const slotStatus = new Map<number, number>();
const reserveStatus = new Map<number, number>();
let colo: string | null = null;

function add(map: Map<number, number>, status: number): void {
  map.set(status, (map.get(status) ?? 0) + 1);
}

for (let i = 0; i < n; i++) {
  const baseline = await timed(() => fetch(new URL("/slots", url)));
  if (baseline.status !== 200) throw new Error(`slots ${baseline.status}`);
  slots.push(baseline.ms);
  add(slotStatus, baseline.status);
  colo ??= baseline.colo;
  if (intervalMs > 0) await sleep(intervalMs);

  const signed = await signRequest(new Request(new URL("/reserve", url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ facility: "court-3" }) }), { mandate, agentKey: agent.priv });
  const hit = await timed(() => fetch(signed));
  if (hit.status !== 200 && hit.status !== 409) throw new Error(`reserve ${hit.status}`);
  reserve.push(hit.ms);
  add(reserveStatus, hit.status);
  colo ??= hit.colo;
  if (intervalMs > 0 && i + 1 < n) await sleep(intervalMs);
}

const result = {
  ...machine(),
  iterations: n,
  intervalMs,
  target: url,
  colo,
  unit: "ms",
  note: "slots p50 subtracted from reserve p50 approximates time spent in verification and the store. The round trip also includes the network and serialization.",
  slots: { p50: percentile(slots, 50), p95: percentile(slots, 95), status: Object.fromEntries(slotStatus) },
  reserve: { p50: percentile(reserve, 50), p95: percentile(reserve, 95), status: Object.fromEntries(reserveStatus) },
  approxVerifyMs: { p50: round(percentile(reserve, 50) - percentile(slots, 50)), p95: round(percentile(reserve, 95) - percentile(slots, 95)) },
};

const path = writeResult("edge-rtt", result);
console.log(path);
console.log(JSON.stringify({ slots: result.slots, reserve: result.reserve, approxVerifyMs: result.approxVerifyMs, colo }, null, 2));
