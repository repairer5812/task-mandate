import { DEFAULT_CLOCK_SKEW_SEC } from "@task-mandate/core";
import type { Intent, Site } from "../engine/types";
import { createSlotBook } from "./slot";

export interface JournalRow {
  at: number;
  person: string;
  origin: string;
  task: string;
  intent: string;
  code: string;
  skew: number;
}

export interface Violation {
  seed: number;
  rule: string;
  detail: string;
  atSec: number;
  tail: JournalRow[];
}

export interface StoreSize {
  nonces: number;
  actions: number;
  people: number;
}

export interface ResponseNote {
  atSec: number;
  personId: string;
  origin: string;
  taskId: string;
  iss: string;
  agentKeyId: string;
  taskBegin: number;
  expiresAt: number;
  maxActions: number;
  skew: number;
  intent: Intent;
  allow: boolean;
  code: string;
  ms: number;
  stoppedExp?: number;
  boundary: boolean;
  claimedNonce: boolean;
  minSwitchSec: number;
}

const CLAIMED = new Set(["allow", "TASK_NOT_ALLOWED", "LIMIT_EXCEEDED", "SUPERSEDED"]);

export function claimedNonce(code: string, allow: boolean): boolean {
  return allow || CLAIMED.has(code);
}

export interface Ledger {
  note(ev: ResponseNote): void;
  probe(atSec: number): void;
  finish(atSec: number): void;
  scenario(kind: "task" | "attack"): void;
  issueRejected(name: string): void;
  allows(iss: string, origin: string, taskId: string): number;
  snapshot(): LedgerSnapshot;
}

export interface LedgerSnapshot {
  requests: number;
  allows: number;
  denies: number;
  tasks: number;
  attacks: number;
  reasons: Record<string, number>;
  legitimate: Record<string, Record<string, number>>;
  bugCandidate: Record<string, Record<string, number>>;
  attackCodes: Record<string, Record<string, number>>;
  violations: Violation[];
  violationCount: number;
  latencies: number[];
  storeMax: StoreSize;
  storeFinal?: StoreSize;
  samples: { atSec: number; size: StoreSize }[];
  issueRejected: Record<string, number>;
}

export function createLedger(seed: number, sites: Site[], checkStore: boolean): Ledger {
  const slots = createSlotBook();
  const actions = new Map<string, { used: number; max: number }>();
  const reasons: Record<string, number> = {};
  const legitimate: Record<string, Record<string, number>> = {};
  const bugCandidate: Record<string, Record<string, number>> = {};
  const attackCodes: Record<string, Record<string, number>> = {};
  const issueRejected: Record<string, number> = {};
  const violations: Violation[] = [];
  const ruleHits = new Map<string, number>();
  const journal: JournalRow[] = [];
  const claims: number[] = [];
  const latencies: number[] = [];
  const samples: { atSec: number; size: StoreSize }[] = [];
  let requests = 0;
  let allows = 0;
  let denies = 0;
  let tasks = 0;
  let attacks = 0;
  let violationCount = 0;
  let storeMax: StoreSize = { nonces: 0, actions: 0, people: 0 };
  let storeFinal: StoreSize | undefined;

  function bump(map: Record<string, Record<string, number>>, group: string, code: string) {
    let row = map[group];
    if (!row) {
      row = {};
      map[group] = row;
    }
    row[code] = (row[code] ?? 0) + 1;
  }

  function violate(rule: string, detail: string, atSec: number) {
    violationCount += 1;
    const seen = ruleHits.get(rule) ?? 0;
    ruleHits.set(rule, seen + 1);
    if (seen < 2) violations.push({ seed, rule, detail, atSec, tail: journal.map((row) => ({ ...row })) });
  }

  function measure(): StoreSize {
    const size = { nonces: 0, actions: 0, people: 0 };
    for (const site of sites) {
      if (!site.store) continue;
      const row = site.store.size();
      size.nonces += row.nonces;
      size.actions += row.actions;
      size.people += row.people;
    }
    return size;
  }

  function track(size: StoreSize) {
    storeMax = { nonces: Math.max(storeMax.nonces, size.nonces), actions: Math.max(storeMax.actions, size.actions), people: Math.max(storeMax.people, size.people) };
  }

  function growth(atSec: number) {
    if (!checkStore) return;
    const size = measure();
    track(size);
    const recent = claims.filter((at) => at > atSec - 400).length;
    if (size.nonces > recent + 5) violate("store growth", `nonce ${size.nonces}, recent claims ${recent}`, atSec);
  }

  return {
    scenario(kind) {
      if (kind === "task") tasks += 1;
      else attacks += 1;
    },
    issueRejected(name) {
      issueRejected[name] = (issueRejected[name] ?? 0) + 1;
    },
    allows(iss, origin, taskId) {
      return actions.get(`${iss}\u0000${origin}\u0000${taskId}`)?.used ?? 0;
    },
    probe(atSec) {
      if (!checkStore) return;
      const size = measure();
      track(size);
      samples.push({ atSec, size });
      growth(atSec);
    },
    finish(atSec) {
      if (!checkStore) return;
      storeFinal = measure();
      track(storeFinal);
      if (storeFinal.nonces || storeFinal.actions || storeFinal.people) {
        violate("store leftover", JSON.stringify(storeFinal), atSec);
      }
    },
    note(ev) {
      requests += 1;
      latencies.push(ev.ms);
      const code = ev.allow ? "allow" : ev.code;
      reasons[code] = (reasons[code] ?? 0) + 1;
      if (ev.allow) allows += 1;
      else denies += 1;
      journal.push({ at: ev.atSec, person: ev.personId, origin: ev.origin, task: ev.taskId, intent: ev.intent.kind === "attack" ? ev.intent.name : ev.intent.kind, code, skew: ev.skew });
      if (journal.length > 40) journal.shift();
      if (ev.claimedNonce) claims.push(ev.atSec);
      if (ev.allow) applyAllow(ev);
      classify(ev);
      growth(ev.atSec);
    },
    snapshot() {
      return { requests, allows, denies, tasks, attacks, reasons: { ...reasons }, legitimate, bugCandidate, attackCodes, violations, violationCount, latencies, storeMax, ...(storeFinal ? { storeFinal } : {}), samples, issueRejected };
    },
  };

  function applyAllow(ev: ResponseNote) {
    const key = `${ev.iss}\u0000${ev.origin}\u0000${ev.taskId}`;
    const row = actions.get(key) ?? { used: 0, max: ev.maxActions };
    row.used += 1;
    row.max = ev.maxActions;
    actions.set(key, row);
    if (row.used > row.max) violate("action count exceeded", `${ev.taskId} ${row.used}/${row.max}`, ev.atSec);
    if (ev.stoppedExp !== undefined && ev.atSec > ev.stoppedExp + DEFAULT_CLOCK_SKEW_SEC) {
      violate("allowed after stop", `${ev.taskId} at ${ev.atSec} exp ${ev.stoppedExp}`, ev.atSec);
    }
    const slot = slots.allow({ personKey: `${ev.personId}\u0000${ev.origin}`, taskKey: key, agentKeyId: ev.agentKeyId, taskBegin: ev.taskBegin, expiresAt: ev.expiresAt, now: ev.atSec, minSwitchSec: ev.minSwitchSec });
    if (slot) violate("person slot", `${slot}: ${ev.personId} ${ev.taskId}`, ev.atSec);
  }

  function classify(ev: ResponseNote) {
    if (ev.intent.kind === "attack") {
      const name = ev.intent.name;
      bump(attackCodes, name, ev.allow ? "allow" : ev.code);
      if (ev.allow) violate("attack allowed", name, ev.atSec);
      else if (ev.intent.expect && ev.code !== ev.intent.expect) bump(bugCandidate, "attack code", `${name}:${ev.code}`);
      return;
    }
    if (ev.skew > DEFAULT_CLOCK_SKEW_SEC) {
      if (ev.allow) violate("allowed beyond clock skew", `${ev.personId} skew ${ev.skew}`, ev.atSec);
      else bump(legitimate, "clock", ev.code);
      return;
    }
    if (ev.allow) return;
    if (ev.intent.kind === "replay") {
      if (ev.code === "REPLAY") bump(legitimate, "replay", ev.code);
      else bump(bugCandidate, "code mismatch", ev.code);
      return;
    }
    if (ev.intent.kind === "early-switch" || ev.intent.kind === "dead-task" || ev.intent.kind === "same-tid-agent") {
      if (ev.code === "SUPERSEDED") bump(legitimate, "person slot", ev.code);
      else bump(bugCandidate, "code mismatch", ev.code);
      return;
    }
    if (ev.intent.kind === "stop-outside") {
      if (ev.code === "EXPIRED") bump(legitimate, "expiry", ev.code);
      else bump(bugCandidate, "code mismatch", ev.code);
      return;
    }
    bump(bugCandidate, ev.boundary ? "renewal boundary" : "unexpected deny", ev.code);
  }
}
