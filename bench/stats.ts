import { mkdirSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { dirname } from "node:path";

export function percentile(samples: number[], p: number): number {
  if (samples.length === 0) throw new Error("no samples");
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  const index = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return round(sorted[index]!);
}

export function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function summarize(samples: number[]): { p50: number; p95: number; p99: number } {
  return { p50: percentile(samples, 50), p95: percentile(samples, 95), p99: percentile(samples, 99) };
}

export function machine(): { measuredAt: string; node: string; cpu: string } {
  return { measuredAt: new Date().toISOString(), node: process.version, cpu: cpus()[0]?.model ?? "unknown" };
}

export function writeResult(name: string, body: unknown): string {
  const day = new Date().toISOString().slice(0, 10);
  const path = `bench/results/${day}_${name}.json`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`);
  return path;
}
