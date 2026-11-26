import { readFile } from "node:fs/promises";
import { parseDuration } from "./duration.js";

/** Command summary printed when arguments are missing. */
export const USAGE = `Usage:
  tm keygen --out key.json
  tm idp keygen --out idp.json
  tm idp attest --idp idp.json --person <person-id> --site https://court.example --principal-pub me.pub.json --duration 30d [--out pa.txt]
  tm issue --principal-key me.json --agent-pub agent.pub.json --site https://court.example --task reserve [--resource court-3] [--max-actions 1] --duration 30m [--person-attestation pa.txt] [--out mandate.txt]
  tm inspect mandate.txt
  tm delegate --principal-key me.json --agent-pub agent.pub.json --site https://court.example --task watch-and-reserve [--resource court-3] [--max-actions 1] --for 7d [--chunk 10m] [--person-attestation pa.txt] [--out ./current-mandate.txt]
  tm run <task-id>
  tm list
  tm stop <task-id>`;

export interface Flags {
  out?: string;
  "principal-key"?: string;
  "agent-pub"?: string;
  site?: string;
  task?: string;
  resource?: string;
  "max-actions"?: string;
  duration?: string;
  for?: string;
  chunk?: string;
  idp?: string;
  person?: string;
  "principal-pub"?: string;
  "person-attestation"?: string;
}

export function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

/** Read a JSON file. The error names the path. */
export async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${file}: could not read file: ${message}`);
  }
}

export async function readJwk(file: string): Promise<JsonWebKey> {
  const parsed = await readJson(file);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${file}: not a JWK`);
  return parsed as JsonWebKey;
}

export function readMaxActions(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) {
    throw new Error("--max-actions must be an integer greater than or equal to 1");
  }
  return Number(value);
}

export function requireDuration(flag: string, value: string | undefined): number {
  if (value === undefined || value === "") throw new Error(`${flag} requires a value`);
  const seconds = parseDuration(value);
  if (seconds === undefined || seconds < 1) throw new Error(`${flag} must use the form 30s, 30m, 2h, or 7d`);
  return seconds;
}
