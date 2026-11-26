const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const LIMIT = 252;

export function receiptFromBytes(bytes: Uint8Array): string | undefined {
  let out = "MO-";
  for (const byte of bytes) {
    if (byte >= LIMIT) continue;
    out += ALPHABET[byte % ALPHABET.length];
    if (out.length === 11) return out;
  }
  return undefined;
}

export function newReceiptNo(): string {
  const out = "MO-";
  while (out.length < 11) {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    const next = receiptFromBytes(bytes);
    if (next) return next;
  }
  return out;
}
