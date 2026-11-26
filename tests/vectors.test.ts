import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Decision, memoryStore, verifyRequest } from "@task-mandate/core";
import { describe, expect, it } from "vitest";

const DIR = fileURLToPath(new URL("../vectors/", import.meta.url));
const CODES = [
  "NO_MANDATE",
  "MANDATE_MALFORMED",
  "MANDATE_SIG_INVALID",
  "ISSUER_NOT_TRUSTED",
  "AUD_MISMATCH",
  "NOT_YET_VALID",
  "EXPIRED",
  "LIFETIME_TOO_LONG",
  "SIG_MISSING",
  "KEY_MISMATCH",
  "SIG_INVALID",
  "BODY_TOO_LARGE",
  "REPLAY",
  "TASK_NOT_ALLOWED",
  "LIMIT_EXCEEDED",
  "PERSON_REQUIRED",
  "PERSON_INVALID",
  "SUPERSEDED",
];

interface VectorFile {
  name: string;
  now: string;
  config: { origin: string; maxBodyBytes?: number };
  route?: { requireTask?: { type: string; resource?: string } };
  steps: { request: { method: string; url: string; headers: Record<string, string>; body?: string }; expected: StoredDecision & { actionConsumed?: boolean } }[];
}

type StoredDecision = Omit<Extract<Decision, { decision: "allow" }>, "refund"> | Extract<Decision, { decision: "challenge" | "deny" }>;

function published(expected: StoredDecision & { actionConsumed?: boolean }): StoredDecision {
  if (expected.decision !== "allow") return expected;
  const { actionConsumed: _actionConsumed, ...decision } = expected;
  return decision;
}

function comparable(decision: Decision): StoredDecision {
  if (decision.decision !== "allow") return decision;
  const { refund: _refund, ...rest } = decision;
  return rest;
}

const files = (await readdir(DIR)).filter((name) => name.endsWith(".json") && name !== "keys.json").sort();

describe("test vectors", () => {
  it("reason codes and an allow case are covered", async () => {
    const seen = new Set<string>();
    for (const name of files) {
      const vector = JSON.parse(await readFile(path.join(DIR, name), "utf8")) as VectorFile;
      for (const step of vector.steps) seen.add(step.expected.decision === "allow" ? "allow" : step.expected.code);
    }
    expect([...seen].sort()).toEqual(["allow", ...CODES].sort());
  });

  for (const name of files) {
    it(name, async () => {
      const vector = JSON.parse(await readFile(path.join(DIR, name), "utf8")) as VectorFile;
      const store = memoryStore();
      const now = new Date(vector.now);
      for (const step of vector.steps) {
        const request = new Request(step.request.url, { method: step.request.method, headers: step.request.headers, body: step.request.body });
        expect(comparable(await verifyRequest(request, vector.config, vector.route ?? {}, store, now))).toEqual(published(step.expected));
      }
    });
  }
});
