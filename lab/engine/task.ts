import { ISSUER_PREFIX, issueMandate, issuePersonAttestation, type LeasePlan, thumbprint } from "@task-mandate/core";
import { Renewer } from "@task-mandate/node";
import type { KeyPair } from "../../bench/keys";
import { IDP_ISS, IDP_SECRET, RESOURCE } from "../config";
import type { Ledger } from "../invariants/ledger";
import { bindLedger, planSend } from "./traffic";
import type { Clock, HeldKey, Queue, Site, Task } from "./types";

export async function held(pair: KeyPair): Promise<HeldKey> {
  return { pair, id: await thumbprint(pair.pub) };
}

export function issuer(id: string): string {
  return `${ISSUER_PREFIX}${id}`;
}

export async function attest(idp: KeyPair, personId: string, principal: KeyPair, audience: string, start: Date, end: Date): Promise<string> {
  const durationSec = Math.max(1, Math.floor((end.getTime() - start.getTime()) / 1000) + 300);
  return issuePersonAttestation({ idpKey: idp.priv, idpIssuer: IDP_ISS, secret: IDP_SECRET, personId, audience, principalPublicKey: principal.pub, durationSec, now: start });
}

export interface OpenTask {
  queue: Queue;
  clock: Clock;
  ledger: Ledger;
  site: Site;
  idp: KeyPair;
  personId: string;
  principal: HeldKey;
  agent: HeldKey;
  taskId: string;
  tbegMs: number;
  tendMs: number;
  chunkSec: number;
  maxActions: number;
  skew: number;
  retry: Task["retry"];
  autoSend: boolean;
  boundaryOnRenew: boolean;
}

export async function openTask(opts: OpenTask): Promise<Task> {
  const tbegSec = Math.floor(opts.tbegMs / 1000);
  const tendSec = Math.floor(opts.tendMs / 1000);
  const start = new Date(tbegSec * 1000);
  const end = new Date(tendSec * 1000);
  const pa = await attest(opts.idp, opts.personId, opts.principal.pair, opts.site.origin, start, end);
  let renewer: Renewer | undefined;
  const task: Task = {
    personId: opts.personId,
    origin: opts.site.origin,
    site: opts.site,
    taskId: opts.taskId,
    principal: opts.principal,
    agent: opts.agent,
    iss: issuer(opts.principal.id),
    pa,
    maxActions: opts.maxActions,
    tbegSec,
    tendSec,
    chunkSec: opts.chunkSec,
    skew: opts.skew,
    chunks: [],
    stopped: false,
    planned: 0,
    retry: opts.retry,
    replayed: false,
    autoSend: opts.autoSend,
    boundaryOnRenew: opts.boundaryOnRenew,
    halt() {
      renewer?.stop();
      task.stopped = true;
      task.stoppedExp = task.window?.exp;
    },
  };
  bindLedger(task, opts.ledger);
  const plan: LeasePlan = { taskId: opts.taskId, start, end, chunkSec: opts.chunkSec };
  renewer = new Renewer({
    plan,
    now: () => new Date(opts.clock.ms),
    issue: async (window) => issueChunk(task, window),
    write: async (mandate) => {
      task.mandate = mandate;
    },
  });
  opts.ledger.scenario("task");
  const active = renewer;
  if (!active) throw new Error("renewer is missing");
  opts.queue.schedule(opts.tbegMs, () => tick(opts.queue, opts.clock, task, active));
  return task;
}

async function issueChunk(task: Task, window: { nbf: Date; exp: Date }): Promise<string> {
  const nbf = Math.floor(window.nbf.getTime() / 1000);
  const exp = Math.floor(window.exp.getTime() / 1000);
  const mandate = await issueMandate({
    principalKey: task.principal.pair.priv,
    agentPublicKey: task.agent.pair.pub,
    audience: task.site.origin,
    task: { type: "reserve", resource: RESOURCE },
    limits: { maxActions: task.maxActions },
    taskId: task.taskId,
    taskBegin: new Date(task.tbegSec * 1000),
    taskEnd: new Date(task.tendSec * 1000),
    durationSec: Math.max(1, exp - nbf),
    notBefore: new Date(nbf * 1000),
    now: new Date(nbf * 1000),
    personAttestation: task.pa,
  });
  task.window = { nbf, exp };
  task.chunks.push({ mandate, nbf, exp });
  task.mandate = mandate;
  return mandate;
}

async function tick(queue: Queue, clock: Clock, task: Task, renewer: Renewer): Promise<void> {
  const result = await renewer.tick();
  if (result !== "issued" || !task.window) return;
  const length = task.window.exp - task.window.nbf;
  if (length > task.chunkSec / 2) {
    // Flooring exp to seconds can land up to 1s before the halfway point. If it is early, the renewer only waits and the next reservation is lost.
    const at = task.window.exp * 1000 - (task.chunkSec * 1000) / 2 + 1000;
    if (at > clock.ms) queue.schedule(at, () => tick(queue, clock, task, renewer));
  }
  if (task.autoSend) planSend(queue, clock, task, clock.ms + 2000, { kind: "honest", boundary: task.chunks.length > 1 }, true);
  if (task.boundaryOnRenew && task.chunks.length > 1) planSend(queue, clock, task, clock.ms, { kind: "honest", boundary: true }, true);
}
