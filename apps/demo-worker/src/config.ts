import type { PersonIssuer } from "@task-mandate/core";
import type { Env } from "./env";

export interface WorkerConfig {
  origin: string;
  seats: Record<string, number>;
  personIssuers: PersonIssuer[];
  requirePerson: boolean;
  onePerPerson: boolean;
  minSwitchSec?: number;
  maxLifetimeSec?: number;
  maxTaskSec?: number;
}

function flag(value: string | undefined): boolean {
  return value === "true";
}

function optionalNumber(value: string | undefined, name: string): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} is not a number`);
  return parsed;
}

export function parseSeats(raw: string | undefined): Record<string, number> {
  if (raw === undefined || raw === "") throw new Error("SEATS is missing");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("SEATS is not JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("SEATS is not an object");
  const seats: Record<string, number> = {};
  for (const [name, count] of Object.entries(value)) {
    if (typeof count !== "number" || !Number.isInteger(count) || count < 0) throw new Error("seat count is invalid");
    seats[name] = count;
  }
  return seats;
}

function parseIssuers(raw: string | undefined): PersonIssuer[] {
  if (raw === undefined || raw === "") return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("PERSON_ISSUERS is not JSON");
  }
  if (!Array.isArray(value)) throw new Error("PERSON_ISSUERS is not an array");
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("issuer entry is not an object");
    const iss = (item as { iss?: unknown }).iss;
    const jwks = (item as { jwks?: unknown }).jwks;
    if (typeof iss !== "string" || iss === "" || !Array.isArray(jwks)) throw new Error("issuer entry is invalid");
    return { iss, jwks: jwks as JsonWebKey[] };
  });
}

function isLoopbackHostname(hostname: string): boolean {
  const name = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return name === "localhost" || name === "127.0.0.1" || name === "::1";
}

export function loopbackOriginMismatch(origin: string, requestHostname: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(origin).hostname;
  } catch {
    return false;
  }
  return isLoopbackHostname(hostname) && !isLoopbackHostname(requestHostname);
}

export function seatResetSec(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 3600;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error("SEAT_RESET_SEC is invalid");
  return parsed;
}

export function readConfig(env: Env): WorkerConfig {
  if (!env.ORIGIN) throw new Error("ORIGIN is missing");
  return {
    origin: env.ORIGIN,
    seats: parseSeats(env.SEATS),
    personIssuers: parseIssuers(env.PERSON_ISSUERS),
    requirePerson: flag(env.REQUIRE_PERSON),
    onePerPerson: flag(env.ONE_PER_PERSON),
    minSwitchSec: optionalNumber(env.MIN_SWITCH_SEC, "MIN_SWITCH_SEC"),
    maxLifetimeSec: optionalNumber(env.MAX_LIFETIME_SEC, "MAX_LIFETIME_SEC"),
    maxTaskSec: optionalNumber(env.MAX_TASK_SEC, "MAX_TASK_SEC"),
  };
}
