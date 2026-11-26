import { DEFAULT_CLOCK_SKEW_SEC, issueMandate } from "@task-mandate/core";
import type { KeyPair } from "../../bench/keys";
import { DAY_MS, RESOURCE } from "../config";
import type { Ledger } from "../invariants/ledger";
import { scheduleAttacks } from "./attacks";
import type { Rng } from "./rng";
import { openTask } from "./task";
import { deliver, planSend, signReserve } from "./traffic";
import type { Clock, Queue, Site, SiteKeys, Task } from "./types";
import { makeSiteKeys } from "./world";

const SKEWS = [0, 0, 0, 0, 0, 0, 0, 0, 30, -30, 10, -10, 45, -45, 31, 0];

type Kind = "short" | "long" | "stop" | "switch" | "multi";

export interface Population {
  queue: Queue;
  clock: Clock;
  ledger: Ledger;
  sites: Site[];
  idp: KeyPair;
  attacker: Map<string, SiteKeys>;
  people: number;
  days: number;
  origin: number;
  rng: Rng;
  strictAttacks: boolean;
}

export async function schedulePopulation(ctx: Population): Promise<void> {
  const kinds = assignKinds(ctx.people, ctx.rng);
  const shorts: Task[] = [];
  for (let index = 0; index < ctx.people; index += 1) {
    const kind = kinds[index] ?? "short";
    const skew = kind === "short" || kind === "long" ? drawSkew(ctx.rng) : 0;
    const start = ctx.origin + startOffset(ctx, kind);
    const site = ctx.sites[index % ctx.sites.length]!;
    if (kind === "multi") {
      await scheduleMulti(ctx, index, start);
      continue;
    }
    const agents = kind === "switch" ? 2 : 1;
    const keys = await makeSiteKeys(agents);
    const task = await open(ctx, keys, site, index, kind, skew, start);
    if (kind === "short") {
      const burst = skew <= 30 && index % 11 === 0 && task.maxActions >= 2;
      armShort(ctx, task, index);
      if (!burst) shorts.push(task);
    } else if (kind === "stop") armStop(ctx, task, start);
    else if (kind === "switch") await armSwitch(ctx, task, keys, site, index, start);
    else if (kind === "long") armCrossLimit(ctx, task);
  }
  for (let day = 1; day <= ctx.days; day += 1) {
    const at = ctx.origin + day * DAY_MS;
    ctx.queue.schedule(at, () => ctx.ledger.probe(Math.floor(ctx.clock.ms / 1000)));
  }
  ctx.queue.schedule(ctx.origin + (ctx.days + 30) * DAY_MS, () => ctx.ledger.finish(Math.floor(ctx.clock.ms / 1000)));
  scheduleAttacks({ queue: ctx.queue, clock: ctx.clock, ledger: ctx.ledger, sites: ctx.sites, idp: ctx.idp, attacker: ctx.attacker, strict: ctx.strictAttacks }, shorts, ctx.rng);
}

async function scheduleMulti(ctx: Population, index: number, start: number): Promise<void> {
  const taskId = `p${index}-multi`;
  for (const site of ctx.sites) {
    const keys = await makeSiteKeys(1);
    const task = await openTask(base(ctx, keys, site, `p${index}`, taskId, 0, start, start + 600_000, 600, 2, "none", false, false));
    planSend(ctx.queue, ctx.clock, task, start + 10_000, { kind: "honest" }, true);
  }
}

function armCrossLimit(ctx: Population, task: Task): void {
  if (task.skew > 30 || task.maxActions < 2) return;
  const at = task.tbegSec * 1000 + 36 * 3_600_000 + 30_000;
  ctx.queue.schedule(at, () => sendCrossLimit(ctx, task));
}

async function sendCrossLimit(ctx: Population, task: Task): Promise<void> {
  if (!task.mandate) return;
  if (ctx.ledger.allows(task.iss, task.origin, task.taskId) < task.maxActions) return;
  const request = await signReserve(task.site, task.mandate, task.agent.pair.priv, new Date(ctx.clock.ms));
  ctx.ledger.scenario("attack");
  await deliver({ clock: ctx.clock, task, intent: { kind: "attack", name: "over chunk limit", expect: "LIMIT_EXCEEDED" }, request, skew: 0 });
}

function armShort(ctx: Population, task: Task, index: number): void {
  const burst = task.skew <= 30 && index % 11 === 0 && task.maxActions >= 2;
  if (burst) {
    task.retry = "none";
    ctx.queue.schedule(task.tbegSec * 1000 + 10_000, () => runBurst(ctx.clock, task));
    return;
  }
  planSend(ctx.queue, ctx.clock, task, task.tbegSec * 1000 + 10_000, { kind: "honest" }, true);
}

async function runBurst(clock: Clock, task: Task): Promise<void> {
  if (!task.mandate) throw new Error("no mandate before the burst");
  const count = Math.min(3, task.maxActions - task.planned);
  if (count < 1) return;
  task.planned += count;
  const now = new Date(clock.ms + task.skew * 1000);
  const signed = [];
  for (let index = 0; index < count; index += 1) signed.push(await signReserve(task.site, task.mandate, task.agent.pair.priv, now));
  const copy = signed[0]!.clone();
  await Promise.all(signed.map((request) => deliver({ clock, task, intent: { kind: "honest" }, request })));
  if (task.skew <= 30) await deliver({ clock, task, intent: { kind: "replay" }, request: copy });
}

function armStop(ctx: Population, task: Task, start: number): void {
  planSend(ctx.queue, ctx.clock, task, start + 3_600_000, { kind: "honest" }, true);
  const stopAt = start + 4 * 3_600_000;
  ctx.queue.schedule(stopAt, () => {
    task.halt();
    const exp = task.stoppedExp;
    if (exp === undefined) return;
    planSend(ctx.queue, ctx.clock, task, (exp - 5) * 1000, { kind: "honest" }, true);
    planSend(ctx.queue, ctx.clock, task, (exp + 15) * 1000, { kind: "stop-inside" }, true);
    planSend(ctx.queue, ctx.clock, task, stopAt + 60_000, { kind: "honest" }, true);
    ctx.queue.schedule((exp + DEFAULT_CLOCK_SKEW_SEC) * 1000, () => sendStopOutside(ctx.clock, task));
  });
}

async function sendStopOutside(clock: Clock, task: Task): Promise<void> {
  await sendPlain(clock, task, { kind: "stop-outside" });
}

async function armSwitch(ctx: Population, task: Task, keys: SiteKeys, site: Site, index: number, start: number): Promise<void> {
  const agentB = keys.agents[1] ?? keys.agents[0]!;
  planSend(ctx.queue, ctx.clock, task, start + 30_000, { kind: "honest" }, true);
  ctx.queue.schedule(start + 60_000, () => sameAgent(ctx.clock, task, agentB));
  const other = await openTask(base(ctx, { principal: keys.principal, agents: [agentB] }, site, `p${index}`, `p${index}-next`, 0, start + 120_000, start + 10_800_000, 3600, 2, "none", false, false));
  ctx.queue.schedule(start + 130_000, () => sendPlain(ctx.clock, other, { kind: "early-switch" }));
  planSend(ctx.queue, ctx.clock, other, start + 900_000, { kind: "honest" }, true);
  ctx.queue.schedule(start + 910_000, () => sendPlain(ctx.clock, task, { kind: "dead-task" }));
}

async function sameAgent(clock: Clock, task: Task, agent: SiteKeys["agents"][number]): Promise<void> {
  const mandate = await issueMandate({
    principalKey: task.principal.pair.priv,
    agentPublicKey: agent.pair.pub,
    audience: task.site.origin,
    task: { type: "reserve", resource: RESOURCE },
    limits: { maxActions: task.maxActions },
    taskId: task.taskId,
    taskBegin: new Date(task.tbegSec * 1000),
    taskEnd: new Date(task.tendSec * 1000),
    durationSec: Math.max(1, task.tendSec - task.tbegSec),
    notBefore: new Date(task.tbegSec * 1000),
    now: new Date(task.tbegSec * 1000),
    personAttestation: task.pa,
  });
  const request = await signReserve(task.site, mandate, agent.pair.priv, new Date(clock.ms));
  await deliver({ clock, task, intent: { kind: "same-tid-agent" }, request, agentKeyId: agent.id, skew: 0 });
}

async function sendPlain(clock: Clock, task: Task, intent: { kind: "early-switch" | "dead-task" | "stop-outside" }): Promise<void> {
  if (!task.mandate) throw new Error(`${task.taskId} has no mandate`);
  const request = await signReserve(task.site, task.mandate, task.agent.pair.priv, new Date(clock.ms));
  await deliver({ clock, task, intent, request, skew: 0 });
}

async function open(ctx: Population, keys: SiteKeys, site: Site, index: number, kind: Kind, skew: number, start: number): Promise<Task> {
  const span = kind === "long" ? 2 * DAY_MS : kind === "stop" ? DAY_MS : kind === "switch" ? 10_800_000 : 600_000;
  const chunk = kind === "long" || kind === "stop" ? 86_400 : kind === "switch" ? 3600 : 600;
  const maxActions = kind === "stop" ? 5 : kind === "switch" ? 3 : (index % 5) + 1;
  const burst = kind === "short" && skew <= 30 && index % 11 === 0 && maxActions >= 2;
  const retry = skew > 30 || burst ? "none" : index % 2 === 0 ? "replay" : "drop";
  return openTask(base(ctx, keys, site, `p${index}`, `p${index}-${kind}`, skew, start, start + span, chunk, maxActions, retry, kind === "long", kind === "short"));
}

function base(ctx: Population, keys: SiteKeys, site: Site, personId: string, taskId: string, skew: number, start: number, end: number, chunkSec: number, maxActions: number, retry: Task["retry"], autoSend: boolean, boundaryOnRenew: boolean) {
  return { queue: ctx.queue, clock: ctx.clock, ledger: ctx.ledger, site, idp: ctx.idp, personId, principal: keys.principal, agent: keys.agents[0]!, taskId, tbegMs: start, tendMs: end, chunkSec, maxActions, skew, retry, autoSend, boundaryOnRenew };
}

function drawSkew(rng: Rng): number {
  return SKEWS[rng.int(0, SKEWS.length - 1)] ?? 0;
}

function shuffle<T>(items: T[], rng: Rng): T[] {
  const copy = items.slice();
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = rng.int(0, index);
    const current = copy[index]!;
    copy[index] = copy[swap]!;
    copy[swap] = current;
  }
  return copy;
}

function assignKinds(people: number, rng: Rng): Kind[] {
  const weights: [Kind, number][] = [
    ["short", 120],
    ["long", 30],
    ["stop", 20],
    ["switch", 15],
    ["multi", 15],
  ];
  const counts = weights.map(([, weight]) => Math.floor((people * weight) / 200));
  counts[0] = (counts[0] ?? 0) + (people - counts.reduce((sum, count) => sum + count, 0));
  const kinds: Kind[] = [];
  weights.forEach(([kind], index) => {
    for (let step = 0; step < (counts[index] ?? 0); step += 1) kinds.push(kind);
  });
  return shuffle(kinds, rng);
}

function startOffset(ctx: Population, kind: Kind): number {
  const span = ctx.days * DAY_MS;
  if (kind === "long") return ctx.rng.int(0, Math.max(0, span - 2 * DAY_MS));
  if (kind === "stop") return ctx.rng.int(0, Math.max(0, span - DAY_MS - 120_000));
  if (kind === "switch") return ctx.rng.int(0, Math.max(0, span - 4 * 3_600_000));
  return ctx.rng.int(0, Math.max(0, span - 20 * 60_000));
}
