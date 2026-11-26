import { readFile } from "node:fs/promises";
import { mandatedFetch } from "@task-mandate/agent";
import { issueMandate } from "@task-mandate/core";
import { checkResults, newKeyPair } from "./core.mjs";

const { origin, endpoints, service, durationSec, maxActions } = JSON.parse(await readFile(new URL("./sandbox.json", import.meta.url), "utf8"));
const headers = { "content-type": "application/json" };

async function readJson(response, label) {
  try {
    return await response.json();
  } catch {
    throw new Error(`${label} returned non-JSON, HTTP ${response.status}`);
  }
}

async function main() {
  const servicesResponse = await fetch(new URL(endpoints.services, origin), { signal: AbortSignal.timeout(10_000), redirect: "error" });
  const catalog = await readJson(servicesResponse, "Service list");
  if (!servicesResponse.ok || !catalog.services?.some((item) => item.id === service)) {
    throw new Error(`The mock service is unavailable, HTTP ${servicesResponse.status}`);
  }

  const [principal, agent] = await Promise.all([newKeyPair(), newKeyPair()]);
  const attestationResponse = await fetch(new URL(endpoints.attest, origin), { method: "POST", headers, body: JSON.stringify({ principalPublicKey: principal.publicKey }), redirect: "error", signal: AbortSignal.timeout(10_000) });
  const { attestation } = await readJson(attestationResponse, "Mock attestation");
  if (!attestationResponse.ok || typeof attestation !== "string") {
    throw new Error(`Mock attestation failed, HTTP ${attestationResponse.status}`);
  }
  const mandate = await issueMandate({ principalKey: principal.privateKey, agentPublicKey: agent.publicKey, audience: origin, task: { type: "apply", resource: service }, limits: { maxActions }, durationSec, personAttestation: attestation });
  const apply = () => mandatedFetch(new URL(endpoints.apply, origin), { method: "POST", headers, body: JSON.stringify({ service }), signal: AbortSignal.timeout(10_000) }, { mandate, agentKey: agent.privateKey });

  const first = await apply();
  const receipt = await readJson(first, "First application");
  console.log("first application:", first.status, receipt.receiptNo ?? receipt.code ?? receipt.error ?? "");
  if (!first.ok) throw new Error(`First mock application failed, HTTP ${first.status}`);

  const second = await apply();
  const refusal = await readJson(second, "Second application");
  console.log("second application:", second.status, refusal.code ?? refusal.error ?? "");
  checkResults(first.status, receipt, second.status, refusal);
}

await main();
