export const DEMO_BODY_LIMIT = 1024;

export function declaredBodyLength(request: Request): number | undefined {
  const header = request.headers.get("content-length");
  if (header === null) return undefined;
  const text = header.trim();
  if (!/^\d+$/.test(text)) return Number.POSITIVE_INFINITY;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : Number.POSITIVE_INFINITY;
}

// If Content-Length is over the cap, do not read the body. If it is absent, read only up to the cap.
// Clone before reading so a later signature check can still see the original body.
export async function readBodyWithin(request: Request, limit = DEMO_BODY_LIMIT): Promise<Uint8Array | undefined> {
  const declared = declaredBodyLength(request);
  if (declared !== undefined && declared > limit) return undefined;
  const stream = request.clone().body;
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.byteLength === 0) continue;
    if (total + value.byteLength > limit) return undefined;
    chunks.push(value);
    total += value.byteLength;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
