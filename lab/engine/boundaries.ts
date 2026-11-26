import { DEFAULT_CLOCK_SKEW_SEC, issueMandate } from "@task-mandate/core";
import { RESOURCE } from "../config";
import type { AttackCtx } from "./attacks";
import { attest, issuer } from "./task";
import { deliver, signReserve } from "./traffic";
import type { Task } from "./types";

export function scheduleBoundaries(ctx: AttackCtx, tasks: Task[]): void {
  const host = tasks.find((task) => task.skew <= 30) ?? tasks[0];
  if (!host) return;
  ctx.queue.schedule(host.tbegSec * 1000 + 75_000, () => nbfEdge(ctx, host));
  ctx.queue.schedule((host.tbegSec + host.chunkSec) * 1000, () => renewEdge(ctx, host));
  ctx.queue.schedule(host.tbegSec * 1000 + 80_000, () => slotEdge(ctx, host));
}

async function attack(ctx: AttackCtx, task: Task, name: string, expect: string, request: Request): Promise<void> {
  ctx.ledger.scenario("attack");
  await deliver({ clock: ctx.clock, task, site: task.site, intent: { kind: "attack", name, expect }, request, skew: 0 });
}

async function nbfEdge(ctx: AttackCtx, task: Task): Promise<void> {
  const nowSec = Math.floor(ctx.clock.ms / 1000);
  const nbf = nowSec + DEFAULT_CLOCK_SKEW_SEC + 1;
  const end = new Date((nbf + 600) * 1000);
  const pa = await attest(ctx.idp, `${task.personId}-nbf`, task.principal.pair, task.site.origin, new Date(nowSec * 1000), end);
  const mandate = await issueMandate({
    principalKey: task.principal.pair.priv,
    agentPublicKey: task.agent.pair.pub,
    audience: task.site.origin,
    task: { type: "reserve", resource: RESOURCE },
    limits: { maxActions: 1 },
    taskId: `${task.taskId}-nbf`,
    taskBegin: new Date(nbf * 1000),
    durationSec: 600,
    notBefore: new Date(nbf * 1000),
    now: new Date(nowSec * 1000),
    taskEnd: end,
    personAttestation: pa,
  });
  await attack(ctx, task, "just before nbf", "NOT_YET_VALID", await signReserve(task.site, mandate, task.agent.pair.priv, new Date(ctx.clock.ms)));
}

async function renewEdge(ctx: AttackCtx, task: Task): Promise<void> {
  const now = new Date(ctx.clock.ms);
  const end = new Date(ctx.clock.ms + 600_000);
  const pa = await attest(ctx.idp, `${task.personId}-renew`, task.principal.pair, task.site.origin, now, end);
  const mandate = await issueMandate({
    principalKey: task.principal.pair.priv,
    agentPublicKey: task.agent.pair.pub,
    audience: task.site.origin,
    task: { type: "reserve", resource: RESOURCE },
    limits: { maxActions: 1 },
    taskId: `${task.taskId}-renew`,
    durationSec: 600,
    notBefore: now,
    now,
    taskBegin: now,
    taskEnd: end,
    personAttestation: pa,
  });
  ctx.ledger.scenario("attack");
  await deliver({ clock: ctx.clock, task, intent: { kind: "honest", boundary: true }, request: await signReserve(task.site, mandate, task.agent.pair.priv, now), skew: 0, personId: `${task.personId}-renew`, taskId: `${task.taskId}-renew`, iss: issuer(task.principal.id) });
}

async function slotEdge(ctx: AttackCtx, task: Task): Promise<void> {
  const personId = `${task.personId}-slot`;
  const start = new Date(ctx.clock.ms);
  const end = new Date(ctx.clock.ms + (task.site.minSwitchSec + 600) * 1000);
  const pa = await attest(ctx.idp, personId, task.principal.pair, task.site.origin, start, end);
  const firstId = `${task.taskId}-slot-a`;
  const first = await issueMandate({ principalKey: task.principal.pair.priv, agentPublicKey: task.agent.pair.pub, audience: task.site.origin, task: { type: "reserve", resource: RESOURCE }, limits: { maxActions: 1 }, taskId: firstId, taskBegin: start, taskEnd: end, durationSec: 600, now: start, personAttestation: pa });
  await deliver({ clock: ctx.clock, task, intent: { kind: "honest" }, request: await signReserve(task.site, first, task.agent.pair.priv, start), skew: 0, personId, taskId: firstId, taskBegin: Math.floor(start.getTime() / 1000), iss: issuer(task.principal.id) });
  ctx.queue.schedule(ctx.clock.ms + task.site.minSwitchSec * 1000, async () => {
    const at = new Date(ctx.clock.ms);
    const secondId = `${task.taskId}-slot-b`;
    const second = await issueMandate({
      principalKey: task.principal.pair.priv,
      agentPublicKey: task.agent.pair.pub,
      audience: task.site.origin,
      task: { type: "reserve", resource: RESOURCE },
      limits: { maxActions: 1 },
      taskId: secondId,
      taskBegin: at,
      taskEnd: end,
      durationSec: Math.max(1, Math.floor((end.getTime() - at.getTime()) / 1000)),
      now: at,
      personAttestation: pa,
    });
    ctx.ledger.scenario("attack");
    await deliver({ clock: ctx.clock, task, intent: { kind: "honest", boundary: true }, request: await signReserve(task.site, second, task.agent.pair.priv, at), skew: 0, personId, taskId: secondId, taskBegin: Math.floor(at.getTime() / 1000), iss: issuer(task.principal.id) });
  });
}
