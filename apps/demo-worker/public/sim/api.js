import { issueMandate, signRequest } from "/js/task-mandate.js";
import { pickOtherService, resolveReason, resolveServiceTitle } from "./constants.js";

const PRESENTER_STORAGE_KEY = "sim_presenter_code";

export function consumePresenterCodeFromUrl() {
  try {
    const url = new URL(window.location.href);
    const code = url.searchParams.get("code");
    if (code !== null && code !== "") {
      window.sessionStorage.setItem(PRESENTER_STORAGE_KEY, code);
      url.searchParams.delete("code");
      const next = url.pathname + url.search + url.hash;
      window.history.replaceState(null, "", next);
    }
  } catch {
    // Ignore environments where sessionStorage or history cannot be used.
  }
}

export function getPresenterCode() {
  try {
    const value = window.sessionStorage.getItem(PRESENTER_STORAGE_KEY);
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

export async function generateEd25519KeyPair() {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const priv = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const pub = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { priv, pub };
}

function readJwtPayload(token) {
  try {
    const parts = String(token).trim().split(".");
    if (parts.length < 2) return null;
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const json = atob(padded);
    return JSON.parse(json);
  } catch {
    return null;
  }
}

export async function requestInterpret(text) {
  const headers = { "content-type": "application/json" };
  const presenterCode = getPresenterCode();
  if (presenterCode) {
    headers["x-presenter-code"] = presenterCode;
  }
  const res = await fetch("/sim/interpret", { method: "POST", headers, body: JSON.stringify({ text }), signal: AbortSignal.timeout(10000) });
  if (!res.ok) {
    throw new Error("말 해석 요청이 실패했습니다 (" + res.status + ")");
  }
  const data = await res.json();
  return {
    source: data && data.source === "llm" ? "llm" : "rule",
    service: data && typeof data.service === "string" ? data.service : null,
    title: data && typeof data.title === "string" ? data.title : null,
    durationSec: data && typeof data.durationSec === "number" ? data.durationSec : 3600,
    maxActions: data && typeof data.maxActions === "number" ? data.maxActions : 1,
  };
}

export async function requestAttest(principalPublicKey) {
  const res = await fetch("/sim/attest", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ principalPublicKey }), signal: AbortSignal.timeout(8000) });
  if (!res.ok) {
    throw new Error("모의 본인 확인 요청이 실패했습니다 (" + res.status + ")");
  }
  const data = await res.json();
  if (!data || typeof data.attestation !== "string") {
    throw new Error("보증서 응답 형식이 올바르지 않습니다");
  }
  return { attestation: data.attestation, issuer: typeof data.issuer === "string" ? data.issuer : "" };
}

export async function createDelegationSession(interpreted) {
  const principal = await generateEd25519KeyPair();
  const agent = await generateEd25519KeyPair();
  const { attestation, issuer } = await requestAttest(principal.pub);
  const now = new Date();
  const nowSec = Math.floor(now.getTime() / 1000);
  const claims = readJwtPayload(attestation);
  const attExp = claims && typeof claims.exp === "number" ? claims.exp : nowSec + 600;
  // issueMandate checks that the chunk exp does not pass the person attestation exp.
  const maxChunkSec = Math.max(1, attExp - nowSec);
  const effectiveDurationSec = Math.min(interpreted.durationSec, maxChunkSec);

  const mandate = await issueMandate({ principalKey: principal.priv, agentPublicKey: agent.pub, audience: window.location.origin, task: { type: "apply", resource: interpreted.service }, limits: { maxActions: interpreted.maxActions }, durationSec: effectiveDurationSec, now, personAttestation: attestation });

  return { principal, agent, attestation, issuer, mandate, service: interpreted.service, title: interpreted.title || resolveServiceTitle(interpreted.service), durationSec: effectiveDurationSec, maxActions: interpreted.maxActions, used: 0 };
}

async function sendSignedOrPlainApply(service, signOpts) {
  let req = new Request(new URL("/civil/apply", window.location.origin), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ service }) });
  if (signOpts) {
    req = await signRequest(req, signOpts);
  }
  const res = await fetch(req, { redirect: "manual", signal: AbortSignal.timeout(8000) });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  let code = null;
  let receiptNo = null;
  if (res.status >= 200 && res.status < 300) {
    receiptNo = body && typeof body.receiptNo === "string" ? body.receiptNo : null;
  } else if (body && typeof body === "object") {
    if (typeof body.code === "string") code = body.code;
    else if (typeof body.error === "string") code = body.error;
  }
  return { status: res.status, ok: res.status === 200, code, service, title: resolveServiceTitle(service), receiptNo, reason: resolveReason(res.status, code), at: new Date().toISOString() };
}

export async function runApplyScenario(scenarioId, session) {
  if (scenarioId === "normal") {
    const result = await sendSignedOrPlainApply(session.service, { mandate: session.mandate, agentKey: session.agent.priv });
    if (result.ok) session.used = (session.used || 0) + 1;
    return result;
  }
  if (scenarioId === "other-service") {
    const otherService = pickOtherService(session.service);
    return sendSignedOrPlainApply(otherService, { mandate: session.mandate, agentKey: session.agent.priv });
  }
  if (scenarioId === "once-more") {
    const remaining = Math.max(0, session.maxActions - (session.used || 0));
    for (let i = 0; i < remaining; i++) {
      const burned = await sendSignedOrPlainApply(session.service, { mandate: session.mandate, agentKey: session.agent.priv });
      if (!burned.ok) return burned;
      session.used = (session.used || 0) + 1;
    }
    return sendSignedOrPlainApply(session.service, { mandate: session.mandate, agentKey: session.agent.priv });
  }
  if (scenarioId === "other-agent") {
    const otherAgent = await generateEd25519KeyPair();
    return sendSignedOrPlainApply(session.service, { mandate: session.mandate, agentKey: otherAgent.priv });
  }
  if (scenarioId === "expired") {
    const endedAt = new Date(Date.now() - 3600_000);
    const issuedAt = new Date(endedAt.getTime() - 600_000);
    const expiredMandate = await issueMandate({ principalKey: session.principal.priv, agentPublicKey: session.agent.pub, audience: window.location.origin, task: { type: "apply", resource: session.service }, limits: { maxActions: 1 }, durationSec: 600, now: issuedAt, personAttestation: session.attestation });
    return sendSignedOrPlainApply(session.service, { mandate: expiredMandate, agentKey: session.agent.priv });
  }
  if (scenarioId === "no-mandate") {
    return sendSignedOrPlainApply(session.service, null);
  }
  throw new Error("알 수 없는 시험 시나리오입니다: " + scenarioId);
}
