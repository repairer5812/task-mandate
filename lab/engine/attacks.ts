import { DEFAULT_CLOCK_SKEW_SEC, issueMandate } from "@task-mandate/core";
import type { KeyPair } from "../../bench/keys";
import { FACILITY_BODY, RESOURCE } from "../config";
import type { Ledger } from "../invariants/ledger";
import { scheduleBoundaries } from "./boundaries.js";
import type { Rng } from "./rng";
import { attest, issuer } from "./task";
import { deliver, signReserve, signReserveUnchecked } from "./traffic.js";
import type { Clock, Queue, Site, SiteKeys, Task } from "./types";

export interface AttackCtx {
  queue: Queue;
  clock: Clock;
  ledger: Ledger;
  sites: Site[];
  idp: KeyPair;
  attacker: Map<string, SiteKeys>;
  strict: boolean;
}

function shuffle<T>(items: T[], rng?: Rng): T[] {
  const copy = items.slice();
  if (!rng) return copy;
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = rng.int(0, index);
    const current = copy[index]!;
    copy[index] = copy[swap]!;
    copy[swap] = current;
  }
  return copy;
}

export function scheduleAttacks(ctx: AttackCtx, tasks: Task[], rng?: Rng): void {
  const jitter = rng ? rng.int(0, 4_000) : 0;
  const rich = shuffle(
    tasks.filter((task) => task.skew <= 30 && task.maxActions >= 3),
    rng,
  );
  const full = shuffle(
    tasks.filter((task) => task.skew <= 30 && task.maxActions === 1 && task.planned >= 1),
    rng,
  );
  const room = shuffle(
    tasks.filter((task) => task.skew <= 30 && task.planned < task.maxActions),
    rng,
  );
  const used = new Set<Task>();
  const take = (list: Task[], label: string) => {
    const task = list.find((item) => !used.has(item));
    if (!task) {
      if (ctx.strict) throw new Error(`${label} has no target`);
      return undefined;
    }
    used.add(task);
    return task;
  };
  const stolen = take(rich, "stolen mandate");
  const cross = take(rich, "other site");
  const swapped = take(rich, "swapped body");
  const expired = take(rich, "just expired");
  const wrong = take(rich, "wrong task type");
  const shadow = take(rich, "mimicked task id");
  const pasted = take(rich, "pasted attestation");
  const header = take(rich, "tampered header");
  const replay = take(room, "replayed signature");
  const limited = take(full, "over action limit");
  if (stolen) ctx.queue.schedule(stolen.tbegSec * 1000 + 40_000 + jitter, () => stolenKey(ctx, stolen));
  if (cross) ctx.queue.schedule(cross.tbegSec * 1000 + 40_000, () => otherSite(ctx, cross));
  if (swapped) ctx.queue.schedule(swapped.tbegSec * 1000 + 40_000, () => swapBody(ctx, swapped));
  if (expired) scheduleExpiry(ctx, expired);
  if (wrong) ctx.queue.schedule(wrong.tbegSec * 1000 + 40_000, () => wrongType(ctx, wrong));
  if (limited) ctx.queue.schedule(limited.tbegSec * 1000 + 40_000, () => overLimit(ctx, limited));
  if (shadow) ctx.queue.schedule(shadow.tbegSec * 1000 + 40_000, () => shadowTid(ctx, shadow));
  if (pasted) ctx.queue.schedule(pasted.tbegSec * 1000 + 40_000, () => pastePa(ctx, pasted));
  if (header) ctx.queue.schedule(header.tbegSec * 1000 + 40_000, () => tamperHeader(ctx, header));
  if (replay) ctx.queue.schedule(replay.tbegSec * 1000 + 40_000, () => replaySig(ctx, replay));
  const host = stolen ?? tasks[0];
  if (host) {
    ctx.queue.schedule(host.tbegSec * 1000 + 50_000, () => longId(ctx, host));
    ctx.queue.schedule(host.tbegSec * 1000 + 55_000, () => hugeMandate(ctx, host));
    ctx.queue.schedule(host.tbegSec * 1000 + 60_000 + jitter, () => hugeBody(ctx, host));
  }
  scheduleBoundaries(ctx, tasks);
}

function keysOf(ctx: AttackCtx, task: Task): SiteKeys {
  const keys = ctx.attacker.get(task.site.origin);
  if (!keys) throw new Error("attacker keys are missing");
  return keys;
}

async function sendAttack(ctx: AttackCtx, task: Task, name: string, expect: string, request: Request, site = task.site): Promise<void> {
  ctx.ledger.scenario("attack");
  await deliver({ clock: ctx.clock, task, site, intent: { kind: "attack", name, expect }, request, skew: 0 });
}

async function stolenKey(ctx: AttackCtx, task: Task): Promise<void> {
  if (!task.mandate) return;
  const keys = keysOf(ctx, task);
  const request = await signReserve(task.site, task.mandate, keys.agents[0]!.pair.priv, new Date(ctx.clock.ms));
  await sendAttack(ctx, task, "stolen mandate", "KEY_MISMATCH", request);
}

async function otherSite(ctx: AttackCtx, task: Task): Promise<void> {
  if (!task.mandate) return;
  const site = ctx.sites.find((item) => item.origin !== task.site.origin);
  if (!site) return;
  const request = await signReserveUnchecked(site, task.mandate, task.agent.pair.priv, new Date(ctx.clock.ms));
  // The attestation aud mismatches the site first. Person attestation is checked before audience.
  await sendAttack(ctx, task, "other site", "PERSON_INVALID", request, site);
}

async function swapBody(ctx: AttackCtx, task: Task): Promise<void> {
  if (!task.mandate) return;
  const signed = await signReserve(task.site, task.mandate, task.agent.pair.priv, new Date(ctx.clock.ms));
  const headers = new Headers(signed.headers);
  const request = new Request(signed.url, { method: signed.method, headers, body: JSON.stringify({ facility: RESOURCE, swapped: true }) });
  await sendAttack(ctx, task, "swapped body", "SIG_INVALID", request);
}

function scheduleExpiry(ctx: AttackCtx, task: Task): void {
  ctx.queue.schedule(task.tbegSec * 1000 + 1000, () => {
    const chunk = task.chunks[0];
    if (!chunk) return;
    ctx.queue.schedule((chunk.exp + DEFAULT_CLOCK_SKEW_SEC) * 1000, async () => {
      const request = await signReserve(task.site, chunk.mandate, task.agent.pair.priv, new Date(ctx.clock.ms));
      await sendAttack(ctx, task, "expiry second", "EXPIRED", request);
    });
  });
}

async function wrongType(ctx: AttackCtx, task: Task): Promise<void> {
  const mandate = await issueFor(task, { type: "cancel" }, task.principal.pair, task.agent.pair.pub, task.pa, `${task.taskId}-cancel`);
  const request = await signReserve(task.site, mandate, task.agent.pair.priv, new Date(ctx.clock.ms));
  await sendAttack(ctx, task, "wrong task type", "TASK_NOT_ALLOWED", request);
}

async function overLimit(ctx: AttackCtx, task: Task): Promise<void> {
  if (!task.mandate) return;
  const request = await signReserve(task.site, task.mandate, task.agent.pair.priv, new Date(ctx.clock.ms));
  await sendAttack(ctx, task, "over action limit", "LIMIT_EXCEEDED", request);
}

async function replaySig(ctx: AttackCtx, task: Task): Promise<void> {
  if (!task.mandate || task.planned >= task.maxActions) return;
  task.planned += 1;
  const signed = await signReserve(task.site, task.mandate, task.agent.pair.priv, new Date(ctx.clock.ms));
  const again = signed.clone();
  await deliver({ clock: ctx.clock, task, intent: { kind: "honest" }, request: signed, skew: 0 });
  ctx.ledger.scenario("attack");
  await deliver({ clock: ctx.clock, task, intent: { kind: "attack", name: "replayed signature", expect: "REPLAY" }, request: again, skew: 0 });
}

async function shadowTid(ctx: AttackCtx, task: Task): Promise<void> {
  const keys = keysOf(ctx, task);
  const start = new Date(task.tbegSec * 1000);
  const end = new Date(task.tendSec * 1000);
  const pa = await attest(ctx.idp, "attacker", keys.principal.pair, task.site.origin, start, end);
  const mandate = await issueFor(task, { type: "reserve" }, keys.principal.pair, keys.agents[0]!.pair.pub, pa, task.taskId);
  const request = await signReserve(task.site, mandate, keys.agents[0]!.pair.priv, new Date(ctx.clock.ms));
  ctx.ledger.scenario("attack");
  await deliver({ clock: ctx.clock, task, intent: { kind: "shadow" }, request, skew: 0, personId: "attacker", iss: issuer(keys.principal.id), agentKeyId: keys.agents[0]!.id, taskId: task.taskId, maxActions: 1 });
}

async function pastePa(ctx: AttackCtx, task: Task): Promise<void> {
  const keys = keysOf(ctx, task);
  try {
    const mandate = await issueFor(task, { type: "reserve" }, keys.principal.pair, keys.agents[0]!.pair.pub, task.pa, `pa-${task.taskId}`);
    const request = await signReserve(task.site, mandate, keys.agents[0]!.pair.priv, new Date(ctx.clock.ms));
    await sendAttack(ctx, task, "pasted attestation", "PERSON_INVALID", request);
  } catch {
    ctx.ledger.issueRejected("pasted attestation");
  }
}

async function tamperHeader(ctx: AttackCtx, task: Task): Promise<void> {
  if (!task.mandate) return;
  const signed = await signReserve(task.site, task.mandate, task.agent.pair.priv, new Date(ctx.clock.ms));
  const headers = new Headers(signed.headers);
  const digest = headers.get("content-digest") ?? "x";
  headers.set("content-digest", `${digest.slice(0, -1)}${digest.endsWith("A") ? "B" : "A"}`);
  const request = new Request(signed.url, { method: signed.method, headers, body: FACILITY_BODY });
  await sendAttack(ctx, task, "tampered header", "SIG_INVALID", request);
}

async function longId(ctx: AttackCtx, task: Task): Promise<void> {
  const mandate = await issueFor(task, { type: "reserve" }, task.principal.pair, task.agent.pair.pub, task.pa, "t".repeat(129));
  const request = await signReserveUnchecked(task.site, mandate, task.agent.pair.priv, new Date(ctx.clock.ms));
  await sendAttack(ctx, task, "long identifier", "MANDATE_MALFORMED", request);
}

async function hugeMandate(ctx: AttackCtx, task: Task): Promise<void> {
  let note = "x".repeat(7000);
  let mandate = await issueFor(task, { type: "reserve", params: { note } }, task.principal.pair, task.agent.pair.pub, task.pa, `big-${task.taskId}`);
  while (new TextEncoder().encode(mandate).byteLength <= 8192 && note.length < 20_000) {
    note += "x".repeat(2000);
    mandate = await issueFor(task, { type: "reserve", params: { note } }, task.principal.pair, task.agent.pair.pub, task.pa, `big-${task.taskId}`);
  }
  if (new TextEncoder().encode(mandate).byteLength <= 8192) throw new Error("oversized mandate did not exceed 8192 bytes");
  const request = await signReserveUnchecked(task.site, mandate, task.agent.pair.priv, new Date(ctx.clock.ms));
  await sendAttack(ctx, task, "oversized mandate", "MANDATE_MALFORMED", request);
}

async function hugeBody(ctx: AttackCtx, task: Task): Promise<void> {
  if (!task.mandate) return;
  const body = JSON.stringify({ facility: RESOURCE, blob: "x".repeat(1_048_576) });
  const request = await signReserve(task.site, task.mandate, task.agent.pair.priv, new Date(ctx.clock.ms), body, new TextEncoder().encode(body).byteLength + 64);
  await sendAttack(ctx, task, "oversized body", "BODY_TOO_LARGE", request);
}

async function issueFor(task: Task, taskBody: { type: string; params?: Record<string, unknown> }, principal: KeyPair, agentPublic: JsonWebKey, pa: string, taskId: string): Promise<string> {
  const exp = task.tbegSec + 600;
  return issueMandate({
    principalKey: principal.priv,
    agentPublicKey: agentPublic,
    audience: task.site.origin,
    task: { type: taskBody.type, resource: RESOURCE, ...(taskBody.params ? { params: taskBody.params } : {}) },
    limits: { maxActions: 1 },
    taskId,
    taskBegin: new Date(task.tbegSec * 1000),
    taskEnd: new Date(Math.max(task.tendSec, exp) * 1000),
    durationSec: 600,
    notBefore: new Date(task.tbegSec * 1000),
    now: new Date(task.tbegSec * 1000),
    personAttestation: pa,
  });
}
