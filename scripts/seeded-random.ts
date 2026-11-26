function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function fnv1a(text: string): number {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export async function withRandom<T>(name: string, run: () => Promise<T>): Promise<T> {
  const next = mulberry32(fnv1a(name));
  const previous = crypto.getRandomValues.bind(crypto);
  crypto.getRandomValues = (<TView extends ArrayBufferView>(array: TView): TView => {
    const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(next() * 256);
    return array;
  }) as typeof crypto.getRandomValues;
  try {
    return await run();
  } finally {
    crypto.getRandomValues = previous;
  }
}
