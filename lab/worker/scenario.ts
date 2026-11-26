import { DEFAULT_CLOCK_SKEW_SEC, issueMandate } from "@task-mandate/core";
import type { KeyPair } from "../../bench/keys";
import { RESOURCE } from "../config";
import { createQueue } from "../engine/loop";
import { openTask } from "../engine/task";
import { deliver, planSend, signReserve } from "../engine/traffic";
import type { Clock, Site, Task } from "../engine/types";
import { makeSiteKeys } from "../engine/world";
import { createLedger, type Ledger } from "../invariants/ledger";

export interface LiveScale {
  minSwitchSec: number;
  chunkSec: number;
  renewSpanSec: number;
}

export function liveScale(horizonMs: number): LiveScale {
  const full = horizonMs >= 120_000;
  return { minSwitchSec: full ? 20 : 2, chunkSec: full ? 40 : 8, renewSpanSec: full ? 120 : 24 };
}

export async function runLiveScenario(opts: { site: Site; idp: KeyPair; scale: LiveScale }): Promise<Ledger> {
  const renewKeys = await makeSiteKeys(1);
  const stopKeys = await makeSiteKeys(1);
  const switchKeys = await makeSiteKeys(2);
  const start = Date.now() + 8_000;
  const clock: Clock = { ms: Date.now() };
  const queue = createQueue(clock, "real");
  const ledger = createLedger(0, [opts.site], false);
  const common = { queue, clock, ledger, site: opts.site, idp: opts.idp, skew: 0, retry: "none" as const, autoSend: false, boundaryOnRenew: false };
  await openTask({ ...common, personId: "renew", principal: renewKeys.principal, agent: renewKeys.agents[0]!, taskId: "live-renew", tbegMs: start, tendMs: start + opts.scale.renewSpanSec * 1000, chunkSec: opts.scale.chunkSec, maxActions: 8, autoSend: true });
  const stop = await openTask({ ...common, personId: "stop", principal: stopKeys.principal, agent: stopKeys.agents[0]!, taskId: "live-stop", tbegMs: start, tendMs: start + opts.scale.chunkSec * 2 * 1000, chunkSec: opts.scale.chunkSec, maxActions: 4 });
  planSend(queue, clock, stop, start + 1000, { kind: "honest" }, true);
  const stopAt = start + Math.max(3000, Math.floor(opts.scale.chunkSec / 4) * 1000);
  queue.schedule(stopAt, () => armStopped(queue, clock, stop));
  const agentB = switchKeys.agents[1] ?? switchKeys.agents[0]!;
  const spanMs = Math.max(opts.scale.chunkSec * 2, opts.scale.minSwitchSec + 30) * 1000;
  const first = await openTask({ ...common, personId: "switch", principal: switchKeys.principal, agent: switchKeys.agents[0]!, taskId: "live-switch-a", tbegMs: start, tendMs: start + spanMs, chunkSec: opts.scale.chunkSec, maxActions: 3 });
  planSend(queue, clock, first, start + 1000, { kind: "honest" }, true);
  queue.schedule(start + 1500, () => sameAgent(clock, first, agentB));
  const next = await openTask({ ...common, personId: "switch", principal: switchKeys.principal, agent: agentB, taskId: "live-switch-b", tbegMs: start + 2000, tendMs: start + spanMs, chunkSec: opts.scale.chunkSec, maxActions: 2 });
  queue.schedule(start + 2500, () => sendKind(clock, next, "early-switch"));
  planSend(queue, clock, next, start + (opts.scale.minSwitchSec + 3) * 1000, { kind: "honest" }, true);
  queue.schedule(start + (opts.scale.minSwitchSec + 4) * 1000, () => sendKind(clock, first, "dead-task"));
  if (start < Date.now()) throw new Error("missed the scenario start time");
  await queue.drain();
  return ledger;
}

function armStopped(queue: ReturnType<typeof createQueue>, clock: Clock, task: Task): void {
  task.halt();
  const exp = task.stoppedExp;
  if (exp === undefined) return;
  planSend(queue, clock, task, (exp - 2) * 1000, { kind: "honest" }, true);
  planSend(queue, clock, task, (exp + 10) * 1000, { kind: "stop-inside" }, true);
  queue.schedule((exp + DEFAULT_CLOCK_SKEW_SEC) * 1000, () => sendKind(clock, task, "stop-outside"));
}

async function sameAgent(clock: Clock, task: Task, agent: Task["agent"]): Promise<void> {
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

async function sendKind(clock: Clock, task: Task, intent: "early-switch" | "dead-task" | "stop-outside"): Promise<void> {
  if (!task.mandate) throw new Error(`${task.taskId} has no mandate`);
  const request = await signReserve(task.site, task.mandate, task.agent.pair.priv, new Date(clock.ms));
  await deliver({ clock, task, intent: { kind: intent }, request, skew: 0 });
}
