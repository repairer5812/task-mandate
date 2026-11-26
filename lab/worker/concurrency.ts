import { issueMandate } from "@task-mandate/core";
import type { KeyPair } from "../../bench/keys";
import { RESOURCE } from "../config";
import { attest } from "../engine/task";
import { readDecision, signReserve } from "../engine/traffic";
import type { Site } from "../engine/types";
import type { DevServer } from "./dev-server";

export interface Counted {
  sent: number;
  allows: number;
  codes: Record<string, number>;
}

export interface ConcurrencyResult {
  burst: Counted & { maxActions: number };
  nonce: Counted;
  person: Counted;
  violations: { rule: string; detail: string }[];
}

function bump(row: Counted, code: string, allow: boolean): void {
  row.sent += 1;
  if (allow) row.allows += 1;
  row.codes[code] = (row.codes[code] ?? 0) + 1;
}

async function local(site: Site, request: Request): Promise<{ allow: boolean; code: string }> {
  const url = new URL(request.url);
  if (url.origin !== site.origin) throw new Error(`target is not local: ${url.origin}`);
  const response = await site.request(request);
  return readDecision(response);
}

async function mandateFor(idp: KeyPair, site: Site, principal: KeyPair, agent: KeyPair, personId: string, taskId: string, maxActions: number): Promise<string> {
  const start = new Date();
  const end = new Date(start.getTime() + 600_000);
  const pa = await attest(idp, personId, principal, site.origin, start, end);
  return issueMandate({ principalKey: principal.priv, agentPublicKey: agent.pub, audience: site.origin, task: { type: "reserve", resource: RESOURCE }, limits: { maxActions }, taskId, taskBegin: start, taskEnd: end, durationSec: 600, now: start, personAttestation: pa });
}

export async function runConcurrency(server: DevServer, site: Site, idp: KeyPair, principal: KeyPair, agents: [KeyPair, KeyPair]): Promise<ConcurrencyResult> {
  const violations: { rule: string; detail: string }[] = [];
  await server.reset();
  const maxActions = 7;
  const burstToken = await mandateFor(idp, site, principal, agents[0], "burst-person", "burst-task", maxActions);
  const burstRequests = [];
  for (let index = 0; index < 50; index += 1) {
    burstRequests.push(await signReserve(site, burstToken, agents[0].priv, new Date()));
  }
  const burst: ConcurrencyResult["burst"] = { sent: 0, allows: 0, codes: {}, maxActions };
  for (const decision of await Promise.all(burstRequests.map((request) => local(site, request)))) bump(burst, decision.code, decision.allow);
  if (burst.allows > maxActions) violations.push({ rule: "concurrent count", detail: `allowed ${burst.allows}, limit ${maxActions}` });

  await server.reset();
  const nonceToken = await mandateFor(idp, site, principal, agents[0], "nonce-person", "nonce-task", 5);
  const signed = await signReserve(site, nonceToken, agents[0].priv, new Date());
  const nonce: Counted = { sent: 0, allows: 0, codes: {} };
  for (const decision of await Promise.all([local(site, signed.clone()), local(site, signed.clone())])) bump(nonce, decision.code, decision.allow);
  if (nonce.allows !== 1) violations.push({ rule: "same nonce", detail: `allowed ${nonce.allows}` });

  await server.reset();
  const start = new Date();
  const end = new Date(start.getTime() + 600_000);
  const pa = await attest(idp, "slot-person", principal, site.origin, start, end);
  const person: Counted = { sent: 0, allows: 0, codes: {} };
  const pair = await Promise.all(
    agents.map(async (agent, index) => {
      const token = await issueMandate({ principalKey: principal.priv, agentPublicKey: agent.pub, audience: site.origin, task: { type: "reserve", resource: RESOURCE }, limits: { maxActions: 2 }, taskId: `slot-${index}`, taskBegin: start, taskEnd: end, durationSec: 600, now: start, personAttestation: pa });
      return signReserve(site, token, agent.priv, new Date());
    }),
  );
  for (const decision of await Promise.all(pair.map((request) => local(site, request)))) bump(person, decision.code, decision.allow);
  if (person.allows > 1) violations.push({ rule: "concurrent person slot", detail: `allowed ${person.allows}` });
  return { burst, nonce, person, violations };
}
