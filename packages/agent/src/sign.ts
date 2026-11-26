import { PROFILE, SIGNATURE_MAX_AGE_SEC, TaskMandateError } from "@task-mandate/core";
import { COMPONENT, contentDigest, normalizePrivateJwk, readChunksWithin, SIGNATURE_TAG, signatureComponents } from "@task-mandate/core/internal";
import { appendSignature, createSignature } from "http-message-sig";
import { generateNonce, sign } from "web-bot-auth";
import { signerFromJWK } from "web-bot-auth/crypto";

// Twice the verifier default (1 MiB). The site's own maxBodyBytes still applies on verification.
const DEFAULT_MAX_BODY_BYTES = 2_097_152;

/** A mandate string, or a function that returns the current one. */
export type MandateSource = string | (() => string | Promise<string>);

/** Read the mandate string. A function source is called once. */
export async function resolveMandate(source: MandateSource): Promise<string> {
  const mandate = typeof source === "function" ? await source() : source;
  if (typeof mandate !== "string" || mandate.trim() === "") throw new TaskMandateError("INPUT_INVALID", "mandate is missing");
  return mandate.trim();
}

interface RequestParts {
  url: string;
  method: string;
  headers: Headers;
  body?: ArrayBuffer;
}

async function readCappedBody(req: Request, maxBodyBytes: number): Promise<ArrayBuffer> {
  const stream = req.clone().body;
  if (!stream) throw new TaskMandateError("INPUT_INVALID", "request body exceeds maxBodyBytes");
  const bytes = await readChunksWithin(stream.getReader(), maxBodyBytes);
  if (!bytes) throw new TaskMandateError("INPUT_INVALID", "request body exceeds maxBodyBytes");
  // Request body is ArrayBuffer. Uint8Array.buffer is ArrayBufferLike.
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

async function requestParts(req: Request, mandate: string, coverDigest: boolean, maxBodyBytes?: number): Promise<RequestParts> {
  const headers = new Headers(req.headers);
  headers.set(PROFILE.header, mandate);
  headers.delete(COMPONENT.contentDigest);
  const body = req.body ? (maxBodyBytes === undefined ? await req.clone().arrayBuffer() : await readCappedBody(req, maxBodyBytes)) : undefined;
  if (coverDigest && body) headers.set(COMPONENT.contentDigest, await contentDigest(body));
  return { url: req.url, method: req.method, headers, body };
}

function buildRequest(parts: RequestParts): Request {
  return new Request(parts.url, { method: parts.method, headers: parts.headers, body: parts.body });
}

/** Sign a request without checking the mandate. Use `mandatedFetch` to check and send. */
export async function signRequest(req: Request, opts: { mandate: MandateSource; agentKey: JsonWebKey; now?: Date; maxBodyBytes?: number }): Promise<Request> {
  const now = opts.now ?? new Date();
  const mandate = await resolveMandate(opts.mandate);
  const parts = await requestParts(req, mandate, true, opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
  const unsigned = buildRequest(parts);
  const signer = await signerFromJWK(normalizePrivateJwk(opts.agentKey));
  // sign() always prepends @authority. The other covered names come from signatureComponents.
  const additionalComponents = signatureComponents(Boolean(parts.body)).filter((name) => name !== COMPONENT.authority);
  const fields = await sign(unsigned, { signer, created: now, expires: new Date(now.getTime() + SIGNATURE_MAX_AGE_SEC * 1000), nonce: generateNonce(), additionalComponents });
  return buildRequest({ ...parts, headers: appendSignature(unsigned.headers, fields) });
}

/** Build a signature with an explicit component list. Test vectors use this because `sign()` always adds `@authority`. */
export async function signComponents(req: Request, opts: { mandate: string; agentKey: JsonWebKey; created: Date; expires: Date; components: readonly string[]; nonce?: string | null }): Promise<Request> {
  const parts = await requestParts(req, opts.mandate, opts.components.includes(COMPONENT.contentDigest));
  const unsigned = buildRequest(parts);
  const signer = await signerFromJWK(normalizePrivateJwk(opts.agentKey));
  const parameters: { created: number; expires: number; keyid: string; alg: string; tag: string; nonce?: string } = { created: Math.floor(opts.created.getTime() / 1000), expires: Math.floor(opts.expires.getTime() / 1000), keyid: signer.keyid, alg: signer.algorithm, tag: SIGNATURE_TAG };
  if (opts.nonce !== null) parameters.nonce = opts.nonce ?? generateNonce();
  const fields = await createSignature(unsigned, { components: opts.components, parameters, signer });
  return buildRequest({ ...parts, headers: appendSignature(unsigned.headers, fields) });
}
