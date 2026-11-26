/** Read until `maxBytes`. Does not cancel the reader: cancel on a cloned body can hang. A chunk past the cap is dropped. */
export async function readChunksWithin(reader: ReadableStreamDefaultReader<Uint8Array>, maxBytes: number): Promise<Uint8Array | undefined> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value || value.byteLength === 0) continue;
    if (total + value.byteLength > maxBytes) return undefined;
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
