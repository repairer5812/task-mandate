const UNIT_SEC = { s: 1, m: 60, h: 3600, d: 86_400 } as const;

export function parseDuration(value: string): number | undefined {
  const match = /^(\d+)([smhd])$/.exec(value);
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = match[2] as keyof typeof UNIT_SEC;
  if (!Number.isSafeInteger(amount)) return undefined;
  return amount * UNIT_SEC[unit];
}
