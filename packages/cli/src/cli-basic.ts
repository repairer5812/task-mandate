import { randomBytes } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { decodeMandateUnverified, issueMandate, normalizePublicJwk, type Task } from "@task-mandate/core";
import { CLAIM, openMandate } from "@task-mandate/core/internal";
import { type Flags, readJwk, readMaxActions, USAGE } from "./cli-shared.js";
import { parseDuration } from "./duration.js";
import { requireOrigin } from "./task-record.js";

// Write a new file in the same directory, then rename it. Do not put a secret into an existing mode-644 file.
export async function writeSecret(file: string, data: string): Promise<void> {
  const target = path.resolve(file);
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.${randomBytes(16).toString("hex")}.tmp`);
  const handle = await open(tmp, "wx", 0o600);
  let closed = false;
  try {
    await handle.writeFile(data, "utf8");
    await handle.sync();
    await handle.close();
    closed = true;
    await rename(tmp, target);
  } catch (error) {
    if (!closed) await handle.close().catch(() => undefined);
    await rm(tmp, { force: true });
    throw error;
  }
}

export function publicKeyPath(out: string): string {
  const parsed = path.parse(out);
  const stem = parsed.ext === ".json" ? parsed.name : parsed.base;
  return path.join(parsed.dir, `${stem}.pub.json`);
}

/** Write a new Ed25519 key pair: the private JWK to `--out` and the public JWK to a sibling `.pub.json`. */
export async function keygen(out: string | undefined): Promise<void> {
  if (!out) throw new Error(`--out is required.\n${USAGE}`);
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as { privateKey: CryptoKey; publicKey: CryptoKey };
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const pub = publicKeyPath(out);
  await writeSecret(out, `${JSON.stringify(jwk, null, 2)}\n`);
  await writeSecret(pub, `${JSON.stringify(normalizePublicJwk(jwk), null, 2)}\n`);
  process.stderr.write(`${out}\n${pub}\n`);
}

/** Issue one mandate and print it, or write it when `--out` is set. */
export async function issue(values: Flags): Promise<void> {
  const principalFile = values["principal-key"];
  const agentFile = values["agent-pub"];
  const site = values.site;
  const taskType = values.task;
  const duration = values.duration;
  if (!principalFile || !agentFile || !site || !taskType || !duration) throw new Error(USAGE);
  requireOrigin(site);
  const durationSec = parseDuration(duration);
  if (durationSec === undefined) throw new Error("--duration must use the form 30s, 30m, 2h, or 7d");
  const maxActions = readMaxActions(values["max-actions"]);
  const task: Task = { type: taskType };
  if (values.resource) task.resource = values.resource;
  const personFile = values["person-attestation"];
  const personAttestation = personFile ? (await readFile(personFile, "utf8")).trim() : undefined;
  const token = await issueMandate({ principalKey: await readJwk(principalFile), agentPublicKey: await readJwk(agentFile), audience: site, task, ...(maxActions !== undefined ? { limits: { maxActions } } : {}), ...(personAttestation ? { personAttestation } : {}), durationSec });
  await writeResult(values.out, token);
}

/** Print the token to stdout, or write it to `out` and print that path on stderr. */
export async function writeResult(out: string | undefined, text: string): Promise<void> {
  if (out) {
    await writeSecret(out, `${text}\n`);
    process.stderr.write(`${out}\n`);
    return;
  }
  process.stdout.write(`${text}\n`);
}

/** Print mandate fields. Status is `verified` or `UNVERIFIED`. */
export async function inspect(file: string | undefined): Promise<void> {
  if (!file) throw new Error(USAGE);
  const text = await readFile(file, "utf8");
  const decoded = decodeMandateUnverified(text);
  if (!decoded) throw new Error("could not read the mandate");
  const opened = await openMandate(text);
  const exp = decoded.payload[CLAIM.exp];
  const remainingSec = typeof exp === "number" ? exp - Math.floor(Date.now() / 1000) : null;
  const status = opened.ok ? "verified" : "UNVERIFIED";
  process.stdout.write(`${JSON.stringify({ status, header: decoded.header, payload: decoded.payload, remainingSec }, null, 2)}\n`);
}
