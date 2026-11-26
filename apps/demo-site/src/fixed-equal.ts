// Hash both strings with SHA-256 before comparing bytes, so a shared prefix does not make compare time depend on length.
export async function fixedEqual(left: string, right: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [leftDigest, rightDigest] = await Promise.all([crypto.subtle.digest("SHA-256", enc.encode(left)), crypto.subtle.digest("SHA-256", enc.encode(right))]);
  const a = new Uint8Array(leftDigest);
  const b = new Uint8Array(rightDigest);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
