import { issuePersonAttestation } from "@task-mandate/core";
import { writeResult, writeSecret } from "./cli-basic.js";
import { type Flags, readJson, readJwk, requireDuration, USAGE } from "./cli-shared.js";
import { requireOrigin } from "./task-record.js";

const DEFAULT_ISSUER = "https://idp.example";

interface IdpFile {
  iss: string;
  secret: string;
  jwk: JsonWebKey;
}

function parseIdp(value: unknown): IdpFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an issuer key file");
  const record = value as Record<string, unknown>;
  const jwk = record.jwk;
  if (typeof record.iss !== "string" || record.iss === "") throw new Error("issuer key file is missing iss");
  if (typeof record.secret !== "string" || record.secret === "") throw new Error("issuer key file is missing secret");
  if (!jwk || typeof jwk !== "object" || Array.isArray(jwk)) throw new Error("not an issuer key file");
  return { iss: record.iss, secret: record.secret, jwk: jwk as JsonWebKey };
}

async function readIdp(file: string): Promise<IdpFile> {
  return parseIdp(await readJson(file));
}

/** Write a new issuer key for person attestations. */
export async function idpKeygen(out: string | undefined): Promise<void> {
  if (!out) throw new Error(`--out is required.\n${USAGE}`);
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  const secretBytes = new Uint8Array(32);
  crypto.getRandomValues(secretBytes);
  const file: IdpFile = { iss: DEFAULT_ISSUER, secret: Buffer.from(secretBytes).toString("base64url"), jwk };
  await writeSecret(out, `${JSON.stringify(file, null, 2)}\n`);
  process.stderr.write(`${out}\n`);
}

/** Issue a person attestation for one site and one principal key. */
export async function idpAttest(values: Flags): Promise<void> {
  const idpFile = values.idp;
  const person = values.person;
  const site = values.site;
  const principalFile = values["principal-pub"];
  if (!idpFile || !person || !site || !principalFile) throw new Error(USAGE);
  const durationSec = requireDuration("--duration", values.duration);
  const idp = await readIdp(idpFile);
  const token = await issuePersonAttestation({ idpKey: idp.jwk, idpIssuer: idp.iss, secret: idp.secret, personId: person, audience: requireOrigin(site), principalPublicKey: await readJwk(principalFile), durationSec });
  await writeResult(values.out, token);
}
