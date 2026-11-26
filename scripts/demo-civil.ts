// Runs six civil-service cases against a deployed demo (--url, --idp, --pause). It never resets state.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { issueMandate } from "@task-mandate/core";
import { signRequest } from "@task-mandate/node";
import { attestFor, type IdpFile, readIdp } from "../bench/idp.js";
import { ed25519, type KeyPair } from "../bench/keys.js";

interface Expected {
  status: number;
  code: string | null;
}

interface Issued {
  mandate: string;
  agent: KeyPair;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  return import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

function originOf(raw: string): string {
  const trimmed = raw.replace(/\/$/, "");
  const url = new URL(trimmed);
  if (url.origin !== trimmed) throw new Error("--url accepts an origin only");
  return url.origin;
}

async function issueApply(input: { idp: IdpFile; origin: string; principal: KeyPair; agent: KeyPair; personId: string; now: Date; durationSec: number; resource: string }): Promise<string> {
  const personAttestation = await attestFor(input.idp, { personId: input.personId, audience: input.origin, principalPublicKey: input.principal.pub, durationSec: 2 * 24 * 3600, now: input.now });
  return issueMandate({ principalKey: input.principal.priv, agentPublicKey: input.agent.pub, audience: input.origin, task: { type: "apply", resource: input.resource }, limits: { maxActions: 1 }, durationSec: input.durationSec, now: input.now, personAttestation });
}

async function readResult(response: Response): Promise<Expected> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (response.status >= 200 && response.status < 300) return { status: response.status, code: null };
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { status: response.status, code: null };
  const record = body as { code?: unknown; error?: unknown };
  if (typeof record.code === "string") return { status: response.status, code: record.code };
  if (typeof record.error === "string") return { status: response.status, code: record.error };
  return { status: response.status, code: null };
}

async function apply(origin: string, service: string, issued?: Issued): Promise<Expected> {
  let request = new Request(new URL("/civil/apply", `${origin}/`), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ service }) });
  if (issued) request = await signRequest(request, { mandate: issued.mandate, agentKey: issued.agent.priv });
  return readResult(await fetch(request, { redirect: "manual" }));
}

function report(name: string, actual: Expected, expected: Expected): boolean {
  const ok = actual.status === expected.status && actual.code === expected.code;
  const shown = actual.code ?? "-";
  const verdict = ok ? "matches expected" : `does not match expected (expected ${expected.status} ${expected.code ?? "-"})`;
  process.stdout.write(`${name}: ${actual.status} ${shown} ${verdict}\n`);
  return ok;
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { url: { type: "string" }, idp: { type: "string" }, pause: { type: "string", default: "1500" } } });
  if (!values.url) throw new Error("--url is required");
  if (!values.idp) throw new Error("--idp is required");
  const pauseMs = Number(values.pause);
  if (!Number.isInteger(pauseMs) || pauseMs < 0) throw new Error("--pause must be an integer of at least 0");
  const origin = originOf(values.url);
  const idp = await readIdp(values.idp);
  const now = new Date();
  const endedAt = new Date(now.getTime() - 3_600_000);
  const issuedAt = new Date(endedAt.getTime() - 600_000);

  const pensionPrincipal = await ed25519();
  const pensionAgent = await ed25519();
  const pension: Issued = { agent: pensionAgent, mandate: await issueApply({ idp, origin, principal: pensionPrincipal, agent: pensionAgent, personId: `pension-${crypto.randomUUID()}`, now, durationSec: 600, resource: "basic-pension" }) };

  const mismatchPrincipal = await ed25519();
  const mismatchHolder = await ed25519();
  const mismatchSigner = await ed25519();
  const mismatch: Issued = { agent: mismatchSigner, mandate: await issueApply({ idp, origin, principal: mismatchPrincipal, agent: mismatchHolder, personId: `mismatch-${crypto.randomUUID()}`, now, durationSec: 600, resource: "basic-pension" }) };

  const expiredPrincipal = await ed25519();
  const expiredAgent = await ed25519();
  const expired: Issued = { agent: expiredAgent, mandate: await issueApply({ idp, origin, principal: expiredPrincipal, agent: expiredAgent, personId: `expired-${crypto.randomUUID()}`, now: issuedAt, durationSec: 600, resource: "basic-pension" }) };

  const steps: Array<{ name: string; expected: Expected; run: () => Promise<Expected> }> = [
    { name: "apply for basic pension without a mandate", expected: { status: 401, code: "NO_MANDATE" }, run: () => apply(origin, "basic-pension") },
    { name: "apply for basic pension with a one-use basic pension mandate", expected: { status: 200, code: null }, run: () => apply(origin, "basic-pension", pension) },
    { name: "apply for a resident copy with the same mandate", expected: { status: 403, code: "TASK_NOT_ALLOWED" }, run: () => apply(origin, "resident-copy", pension) },
    { name: "apply for basic pension again with the same mandate", expected: { status: 403, code: "LIMIT_EXCEEDED" }, run: () => apply(origin, "basic-pension", pension) },
    { name: "sign with a different agent key", expected: { status: 403, code: "KEY_MISMATCH" }, run: () => apply(origin, "basic-pension", mismatch) },
    { name: "mandate that ended one hour ago", expected: { status: 403, code: "EXPIRED" }, run: () => apply(origin, "basic-pension", expired) },
  ];

  let ok = true;
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    if (!report(step.name, await step.run(), step.expected)) ok = false;
    if (pauseMs > 0 && i < steps.length - 1) await sleep(pauseMs);
  }
  return ok ? 0 : 1;
}

if (isDirectRun()) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
