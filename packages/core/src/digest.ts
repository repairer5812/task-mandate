import { COMPONENT } from "./profile.js";

/** RFC 9530 `Content-Digest`. The signature covers this header, so the body is hashed here. */
export async function contentDigest(body: Uint8Array | ArrayBuffer): Promise<string> {
  const source = body instanceof Uint8Array ? body : new Uint8Array(body);
  const copy = new ArrayBuffer(source.byteLength);
  new Uint8Array(copy).set(source);
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", copy));
  let binary = "";
  for (const byte of hash) binary += String.fromCharCode(byte);
  return `sha-256=:${btoa(binary)}:`;
}

/** Component names to cover. Includes `content-digest` only when the request has a body. */
export function signatureComponents(hasBody: boolean): string[] {
  const names: string[] = [COMPONENT.method, COMPONENT.authority, COMPONENT.path, COMPONENT.query, COMPONENT.mandate];
  if (hasBody) names.push(COMPONENT.contentDigest);
  return names;
}
