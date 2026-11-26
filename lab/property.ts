import { type Decision, decodeMandateUnverified, issueMandate, memoryStore, TaskMandateError, verifyRequest } from "@task-mandate/core";
import { signRequest } from "@task-mandate/node";
import { assert, asyncProperty, constantFrom, integer, pre } from "fast-check";
import { ed25519, type KeyPair } from "../bench/keys";
import { withRandom } from "../scripts/seeded-random";
import type { PropertyResult } from "./report";

const ORIGIN = "https://time.lab";
const SKEW = 30;
const NBF = Math.floor(Date.parse("2026-12-01T00:00:00Z") / 1000);
const EXP = NBF + 600;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_~.";

function codeOf(decision: Decision): string {
  return decision.decision === "allow" ? "allow" : decision.code;
}

function phase(now: number, nbf: number, exp: number): "early" | "open" | "late" {
  if (now < nbf - SKEW) return "early";
  if (now >= exp + SKEW) return "late";
  return "open";
}

function expectCode(now: number, nbf: number, exp: number): string {
  const kind = phase(now, nbf, exp);
  if (kind === "early") return "NOT_YET_VALID";
  if (kind === "late") return "EXPIRED";
  return "allow";
}

// Decoded header, payload, and signature bytes. Two tokens with the same value here are the same mandate.
function canonical(token: string): string | undefined {
  const decoded = decodeMandateUnverified(token);
  const signature = token.split("~")[0]?.split(".")[2];
  if (!decoded || signature === undefined) return undefined;
  return JSON.stringify([decoded.header, decoded.payload, Buffer.from(signature, "base64url").toString("hex")]);
}

function tamper(token: string, index: number, mode: "replace" | "delete" | "insert", alphabetIndex: number): string {
  const at = index % token.length;
  const ch = ALPHABET[alphabetIndex % ALPHABET.length] ?? "x";
  if (mode === "delete") return token.slice(0, at) + token.slice(at + 1);
  if (mode === "insert") return token.slice(0, at) + ch + token.slice(at);
  return token.slice(0, at) + ch + token.slice(at + 1);
}

async function issuePlain(principal: KeyPair, agent: KeyPair, over: Partial<Parameters<typeof issueMandate>[0]> = {}): Promise<string> {
  return issueMandate({
    principalKey: principal.priv,
    agentPublicKey: agent.pub,
    audience: ORIGIN,
    task: { type: "reserve", resource: "court-3" },
    durationSec: EXP - NBF,
    notBefore: new Date(NBF * 1000),
    now: new Date(NBF * 1000),
    taskBegin: new Date(NBF * 1000),
    taskEnd: new Date(EXP * 1000),
    taskId: "time-task",
    ...over,
  });
}

async function decide(token: string, agent: KeyPair, atSec: number): Promise<string> {
  const at = new Date(atSec * 1000);
  try {
    return await decideSigned(token, agent, at);
  } catch (error) {
    if (error instanceof TaskMandateError && atSec > EXP + SKEW) return "EXPIRED";
    throw error;
  }
}

async function decideSigned(token: string, agent: KeyPair, at: Date): Promise<string> {
  const request = await signRequest(new Request(`${ORIGIN}/reserve`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ facility: "court-3" }) }), { mandate: token, agentKey: agent.priv, now: at });
  const outcome = await verifyRequest(request, { origin: ORIGIN }, { requireTask: { type: "reserve", resource: "court-3" } }, memoryStore(), at);
  return codeOf(outcome);
}

export async function runProperties(): Promise<PropertyResult> {
  return withRandom("lab-property", async () => {
    const principal = await ed25519();
    const agent = await ed25519();
    const token = await issuePlain(principal, agent);
    const issued = canonical(token);
    if (!issued) throw new Error("issued mandate did not decode");
    const tamperResult = { runs: 0, allowed: 0, threw: 0 };
    await assert(
      asyncProperty(integer({ min: 0, max: Math.max(0, token.length - 1) }), constantFrom("replace" as const, "delete" as const, "insert" as const), integer({ min: 0, max: ALPHABET.length - 1 }), async (index, mode, alphabetIndex) => {
        const mutated = tamper(token, index, mode, alphabetIndex);
        pre(mutated !== token && mutated.length > 0);
        // A change to spare base64url bits decodes to the same mandate and is not tampering.
        pre(canonical(mutated) !== issued);
        tamperResult.runs += 1;
        try {
          const code = await decideSigned(mutated, agent, new Date((NBF + 10) * 1000));
          if (code === "allow") tamperResult.allowed += 1;
          return code !== "allow";
        } catch {
          tamperResult.threw += 1;
          return true;
        }
      }),
      { seed: 20261126, numRuns: 1000 },
    );

    const time = { runs: 0, mismatches: 0, boundaryFails: [] as string[] };
    const boundaries: [string, number, string][] = [
      ["nbf-30", NBF - 30, "allow"],
      ["nbf-31", NBF - 31, "NOT_YET_VALID"],
      ["exp+30", EXP + 30, "EXPIRED"],
      ["exp+31", EXP + 31, "EXPIRED"],
    ];
    for (const [name, at, expected] of boundaries) {
      const code = await decide(token, agent, at);
      time.runs += 1;
      if (code !== expected) {
        time.mismatches += 1;
        time.boundaryFails.push(`${name}:${code}`);
      }
    }
    await assert(
      asyncProperty(integer({ min: -800, max: 800 }), integer({ min: -800, max: 800 }), integer({ min: -800, max: 800 }), async (a, b, c) => {
        const times = [NBF + a, NBF + b, NBF + c].sort((left, right) => left - right);
        const ranks = { early: 0, open: 1, late: 2 };
        let previous = 0;
        for (const at of times) {
          time.runs += 1;
          let code: string;
          try {
            code = await decide(token, agent, at);
          } catch (error) {
            time.mismatches += 1;
            time.boundaryFails.push(`throw:${error instanceof Error ? error.message : "error"}`);
            return false;
          }
          const expected = expectCode(at, NBF, EXP);
          const kind = phase(at, NBF, EXP);
          if (code !== expected || ranks[kind] < previous) {
            time.mismatches += 1;
            return false;
          }
          previous = ranks[kind];
        }
        return true;
      }),
      { seed: 20261126, numRuns: 1000 },
    );
    await assert(
      asyncProperty(integer({ min: 1, max: 500 }), async (gap) => {
        time.runs += 1;
        const broken = await issuePlain(principal, agent, { taskBegin: new Date((NBF + gap) * 1000), taskId: `gap-${gap}` });
        const code = await decideSigned(broken, agent, new Date((NBF + 10) * 1000));
        if (code !== "MANDATE_MALFORMED") {
          time.mismatches += 1;
          return false;
        }
        return true;
      }),
      { seed: 20261126, numRuns: 1000 },
    );
    return { tamper: tamperResult, time };
  });
}
