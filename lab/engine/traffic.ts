import { DEFAULT_CLOCK_SKEW_SEC, SIGNATURE_MAX_AGE_SEC } from "@task-mandate/core";
import { signatureComponents } from "@task-mandate/core/internal";
import { signRequest } from "@task-mandate/node";
import { signComponents } from "../../packages/agent/src/sign.js";
import { FACILITY_BODY } from "../config";
import { claimedNonce, type ResponseNote } from "../invariants/ledger";
import type { Clock, Intent, Queue, Site, Task } from "./types";

export interface DeliverOpts {
  clock: Clock;
  task: Task;
  intent: Intent;
  request: Request;
  site?: Site;
  agentKeyId?: string;
  iss?: string;
  taskId?: string;
  personId?: string;
  skew?: number;
  maxActions?: number;
  taskBegin?: number;
  expiresAt?: number;
}

// Sign without the agent-side mandate checks, for attacks that send a broken mandate.
export async function signReserveUnchecked(site: Site, mandate: string, agentKey: JsonWebKey, now: Date, body = FACILITY_BODY): Promise<Request> {
  return signComponents(new Request(`${site.origin}/reserve`, { method: "POST", headers: { "content-type": "application/json" }, body }), { mandate, agentKey, created: now, expires: new Date(now.getTime() + SIGNATURE_MAX_AGE_SEC * 1000), components: signatureComponents(true) });
}

export async function signReserve(site: Site, mandate: string, agentKey: JsonWebKey, now: Date, body = FACILITY_BODY, maxBodyBytes?: number): Promise<Request> {
  return signRequest(new Request(`${site.origin}/reserve`, { method: "POST", headers: { "content-type": "application/json" }, body }), { mandate, agentKey, now, ...(maxBodyBytes !== undefined ? { maxBodyBytes } : {}) });
}

export async function readDecision(response: Response): Promise<{ allow: boolean; code: string }> {
  let payload: { ok?: boolean; code?: string } = {};
  try {
    payload = (await response.json()) as { ok?: boolean; code?: string };
  } catch {
    return { allow: false, code: `http-${response.status}` };
  }
  if (response.status >= 200 && response.status < 300 && payload.ok === true) return { allow: true, code: "allow" };
  return { allow: false, code: typeof payload.code === "string" ? payload.code : `http-${response.status}` };
}

export function planSend(queue: Queue, clock: Clock, task: Task, at: number, intent: Intent, budget: boolean): boolean {
  if (at < clock.ms) return false;
  if (budget) {
    if (task.planned >= task.maxActions) return false;
    task.planned += 1;
  }
  queue.schedule(at, () => sendTask(clock, task, intent));
  return true;
}

export async function sendTask(clock: Clock, task: Task, intent: Intent, mandate = task.mandate, agent = task.agent): Promise<void> {
  if (!mandate) throw new Error(`${task.taskId} has no mandate`);
  const skew = task.skew;
  const now = new Date(clock.ms + skew * 1000);
  if (intent.kind === "honest" && task.retry === "drop" && !task.replayed && !intent.boundary) {
    await signReserve(task.site, mandate, agent.pair.priv, now);
  }
  const signed = await signReserve(task.site, mandate, agent.pair.priv, now);
  const replay = intent.kind === "honest" && task.retry === "replay" && !task.replayed && !intent.boundary && skew <= 30;
  if (replay) task.replayed = true;
  await deliver({ clock, task, intent, request: replay ? signed.clone() : signed, agentKeyId: agent.id });
  if (replay) await deliver({ clock, task, intent: { kind: "replay" }, request: signed, agentKeyId: agent.id });
}

export async function deliver(opts: DeliverOpts): Promise<{ allow: boolean; code: string }> {
  const site = opts.site ?? opts.task.site;
  const started = performance.now();
  const headers = new Headers(opts.request.headers);
  const person = opts.personId ?? opts.task.personId;
  if (!headers.has("cf-connecting-ip")) headers.set("cf-connecting-ip", person);
  const response = await site.request(new Request(opts.request, { headers }));
  const decision = await readDecision(response);
  const note: ResponseNote = {
    atSec: Math.floor(opts.clock.ms / 1000),
    personId: opts.personId ?? opts.task.personId,
    origin: site.origin,
    taskId: opts.taskId ?? opts.task.taskId,
    iss: opts.iss ?? opts.task.iss,
    agentKeyId: opts.agentKeyId ?? opts.task.agent.id,
    taskBegin: opts.taskBegin ?? opts.task.tbegSec,
    expiresAt: opts.expiresAt ?? opts.task.tendSec + DEFAULT_CLOCK_SKEW_SEC,
    maxActions: opts.maxActions ?? opts.task.maxActions,
    skew: opts.skew ?? opts.task.skew,
    intent: opts.intent,
    allow: decision.allow,
    code: decision.code,
    ms: performance.now() - started,
    ...(opts.task.stopped && opts.task.stoppedExp !== undefined ? { stoppedExp: opts.task.stoppedExp } : {}),
    boundary: opts.intent.kind === "honest" && opts.intent.boundary === true,
    claimedNonce: claimedNonce(decision.code, decision.allow),
    minSwitchSec: site.minSwitchSec,
  };
  currentLedger(opts).note(note);
  return decision;
}

// Keyed by Task, so requests and sites need no ledger field.
const ledgers = new WeakMap<Task, { note(ev: ResponseNote): void }>();

export function bindLedger(task: Task, ledger: { note(ev: ResponseNote): void }): void {
  ledgers.set(task, ledger);
}

function currentLedger(opts: DeliverOpts): { note(ev: ResponseNote): void } {
  const ledger = ledgers.get(opts.task);
  if (!ledger) throw new Error("ledger is missing");
  return ledger;
}
