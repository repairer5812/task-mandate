// Mandate format size limits. Checked before the mandate signature.
export const LIMIT = { headerBytes: 8192, idChars: 128, nameChars: 256, attestationBytes: 4096 } as const;

export function utf8Size(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
