import type { PersonSlotClaim } from "@task-mandate/core";
import { advanceAction, applyPersonClaim, type PersonState, prunePersonState } from "@task-mandate/core/internal";
import { advanceCivilWindow, type CivilLogEntry, civilWindowCutoff, type SeatResult } from "@task-mandate/demo-site";
import { parseSeats } from "./config";
import { decodeKey, encodeKey } from "./keys";
import { clearSimTables, ensureSimSchema } from "./sim-sql";

interface SqlRows {
  toArray(): Record<string, unknown>[];
}

export interface Sql {
  exec(query: string, ...bindings: unknown[]): SqlRows & Iterable<Record<string, unknown>>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS nonces (
  nonce TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS actions (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS people (
  person_key TEXT PRIMARY KEY,
  state TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS seats (
  facility TEXT PRIMARY KEY,
  remaining INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS civil_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  status INTEGER NOT NULL,
  code TEXT,
  service TEXT,
  task TEXT
);
CREATE TABLE IF NOT EXISTS civil_limit (
  client_key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);
`;

const SEAT_RESET_KEY = "seat_reset_at";

function num(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error("stored value is not a number");
  return parsed;
}

// Stored key stays `finished` so existing Durable Object rows stay readable.
interface StoredPersonState {
  current?: PersonState["current"];
  finished?: PersonState["displaced"];
}

function personStateFromStored(raw: string): PersonState {
  const stored = JSON.parse(raw) as StoredPersonState;
  const state = { displaced: stored.finished } as PersonState;
  if (stored.current) state.current = stored.current;
  return state;
}

function storedPersonState(state: PersonState): string {
  const stored: StoredPersonState = { finished: state.displaced };
  if (state.current) stored.current = state.current;
  return JSON.stringify(stored);
}

function one(sql: Sql, query: string, ...bindings: unknown[]): Record<string, unknown> | undefined {
  return sql.exec(query, ...bindings).toArray()[0];
}

export function ensureSchema(sql: Sql): void {
  sql.exec(SCHEMA);
  ensureSimSchema(sql);
}

export function seedSeats(sql: Sql, raw: string, force: boolean): void {
  const existing = one(sql, "SELECT COUNT(*) AS n FROM seats");
  if (!force && num(existing?.n ?? 0) > 0) return;
  if (force) sql.exec("DELETE FROM seats");
  for (const [facility, remaining] of Object.entries(parseSeats(raw))) {
    sql.exec("INSERT INTO seats (facility, remaining) VALUES (?, ?)", encodeKey(facility), remaining);
  }
}

export function purgeExpired(sql: Sql, nowMs: number): void {
  sql.exec("DELETE FROM nonces WHERE expires_at <= ?", nowMs);
  sql.exec("DELETE FROM actions WHERE expires_at <= ?", nowMs);
  const nowSec = Math.floor(nowMs / 1000);
  for (const row of sql.exec("SELECT person_key, state FROM people").toArray()) {
    const key = String(row.person_key);
    let state: PersonState;
    try {
      state = personStateFromStored(String(row.state));
    } catch {
      sql.exec("DELETE FROM people WHERE person_key = ?", key);
      continue;
    }
    const pruned = prunePersonState(state, nowSec);
    if (!pruned) sql.exec("DELETE FROM people WHERE person_key = ?", key);
    else if (pruned !== state) sql.exec("UPDATE people SET state = ? WHERE person_key = ?", storedPersonState(pruned), key);
  }
}

export function claimNonce(sql: Sql, stored: string, ttlSec: number, nowMs: number): boolean {
  sql.exec("DELETE FROM nonces WHERE nonce = ? AND expires_at <= ?", stored, nowMs);
  const row = one(sql, "SELECT expires_at FROM nonces WHERE nonce = ?", stored);
  if (row && num(row.expires_at) > nowMs) return false;
  sql.exec("INSERT INTO nonces (nonce, expires_at) VALUES (?, ?) ON CONFLICT(nonce) DO UPDATE SET expires_at = excluded.expires_at", stored, nowMs + ttlSec * 1000);
  return true;
}

export function consumeAction(sql: Sql, stored: string, max: number, ttlSec: number, nowMs: number): boolean {
  sql.exec("DELETE FROM actions WHERE key = ? AND expires_at <= ?", stored, nowMs);
  const row = one(sql, "SELECT count, expires_at FROM actions WHERE key = ?", stored);
  const live = row && num(row.expires_at) > nowMs ? row : undefined;
  const nowSec = Math.floor(nowMs / 1000);
  const next = advanceAction(live ? { count: num(live.count), expiresAt: Math.floor(num(live.expires_at) / 1000) } : undefined, nowSec, max, ttlSec);
  const expiresMs = next.row.expiresAt * 1000;
  if (!next.allowed) {
    if (live && expiresMs > num(live.expires_at)) sql.exec("UPDATE actions SET expires_at = ? WHERE key = ?", expiresMs, stored);
    return false;
  }
  sql.exec("INSERT INTO actions (key, count, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET count = excluded.count, expires_at = excluded.expires_at", stored, next.row.count, expiresMs);
  return true;
}

export function refundAction(sql: Sql, stored: string, nowMs: number): void {
  sql.exec("DELETE FROM actions WHERE key = ? AND expires_at <= ?", stored, nowMs);
  const row = one(sql, "SELECT count, expires_at FROM actions WHERE key = ?", stored);
  if (!row || num(row.expires_at) <= nowMs || num(row.count) <= 0) return;
  if (num(row.count) === 1) {
    sql.exec("DELETE FROM actions WHERE key = ?", stored);
    return;
  }
  sql.exec("UPDATE actions SET count = ? WHERE key = ?", num(row.count) - 1, stored);
}

export function claimPersonSlot(sql: Sql, input: PersonSlotClaim): "ok" | "superseded" {
  const stored = input.personKey;
  const row = one(sql, "SELECT state FROM people WHERE person_key = ?", stored);
  let current: PersonState | undefined;
  if (row) {
    try {
      current = personStateFromStored(String(row.state));
    } catch {
      current = undefined;
    }
  }
  const pruned = current ? prunePersonState(current, input.now) : undefined;
  const next = applyPersonClaim(pruned, input);
  sql.exec("INSERT INTO people (person_key, state) VALUES (?, ?) ON CONFLICT(person_key) DO UPDATE SET state = excluded.state", stored, storedPersonState(next.state));
  return next.result;
}

export function listSeats(sql: Sql): Record<string, number> {
  const seats: Record<string, number> = {};
  for (const row of sql.exec("SELECT facility, remaining FROM seats")) {
    seats[decodeKey(String(row.facility))] = num(row.remaining);
  }
  return seats;
}

export function releaseSeat(sql: Sql, facility: string): void {
  const stored = encodeKey(facility);
  const row = one(sql, "SELECT remaining FROM seats WHERE facility = ?", stored);
  if (!row) return;
  sql.exec("UPDATE seats SET remaining = remaining + 1 WHERE facility = ?", stored);
}

export function takeSeat(sql: Sql, facility: string): SeatResult {
  const stored = encodeKey(facility);
  const row = one(sql, "SELECT remaining FROM seats WHERE facility = ?", stored);
  if (!row) return { status: "not-found" };
  if (num(row.remaining) <= 0) return { status: "full" };
  sql.exec("UPDATE seats SET remaining = remaining - 1 WHERE facility = ? AND remaining > 0", stored);
  const after = one(sql, "SELECT remaining FROM seats WHERE facility = ?", stored);
  return { status: "ok", remaining: num(after?.remaining) };
}

export function clearRecords(sql: Sql): void {
  sql.exec("DELETE FROM nonces");
  sql.exec("DELETE FROM actions");
  sql.exec("DELETE FROM people");
  sql.exec("DELETE FROM civil_log");
  sql.exec("DELETE FROM civil_limit");
  clearSimTables(sql);
}

function textOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

// Civil logs and rate limits do not use the expiry alarm. A finished window is deleted on each hit.
export function appendCivilLog(sql: Sql, entry: CivilLogEntry): void {
  sql.exec("INSERT INTO civil_log (at, status, code, service, task) VALUES (?, ?, ?, ?, ?)", entry.at, entry.status, entry.code, entry.service, entry.task);
  sql.exec("DELETE FROM civil_log WHERE id NOT IN (SELECT id FROM civil_log ORDER BY id DESC LIMIT 50)");
}

export function hitCivilLimit(sql: Sql, storedKey: string, nowMs: number, limit: number, windowSec: number): boolean {
  const cutoff = civilWindowCutoff(nowMs, windowSec);
  sql.exec("DELETE FROM civil_limit WHERE window_start <= ?", cutoff);
  const row = one(sql, "SELECT window_start, count FROM civil_limit WHERE client_key = ?", storedKey);
  const current = row ? { startMs: num(row.window_start), count: num(row.count) } : undefined;
  const next = advanceCivilWindow(current, nowMs, limit, windowSec);
  sql.exec("INSERT INTO civil_limit (client_key, window_start, count) VALUES (?, ?, ?) ON CONFLICT(client_key) DO UPDATE SET window_start = excluded.window_start, count = excluded.count", storedKey, next.row.startMs, next.row.count);
  return next.allowed;
}

export function recentCivilLog(sql: Sql): CivilLogEntry[] {
  return sql
    .exec("SELECT at, status, code, service, task FROM civil_log ORDER BY id DESC LIMIT 50")
    .toArray()
    .map((row) => ({ at: String(row.at), status: num(row.status), code: textOrNull(row.code), service: textOrNull(row.service), task: textOrNull(row.task) }));
}

export function armSeatReset(sql: Sql, nowMs: number, resetSec: number): void {
  const row = one(sql, "SELECT value FROM meta WHERE key = ?", SEAT_RESET_KEY);
  if (row) return;
  sql.exec("INSERT INTO meta (key, value) VALUES (?, ?)", SEAT_RESET_KEY, nowMs + resetSec * 1000);
}

export function restoreSeatsIfDue(sql: Sql, rawSeats: string, nowMs: number): void {
  const row = one(sql, "SELECT value FROM meta WHERE key = ?", SEAT_RESET_KEY);
  if (!row || num(row.value) > nowMs) return;
  seedSeats(sql, rawSeats, true);
  sql.exec("DELETE FROM meta WHERE key = ?", SEAT_RESET_KEY);
}

export function clearSeatReset(sql: Sql): void {
  sql.exec("DELETE FROM meta WHERE key = ?", SEAT_RESET_KEY);
}

function optionalTime(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return undefined;
  return parsed;
}

function consider(next: number | undefined, at: number | undefined, nowMs: number): { next: number | undefined; overdue: boolean } {
  if (at === undefined) return { next, overdue: false };
  if (at <= nowMs) return { next, overdue: true };
  if (next === undefined || at < next) return { next: at, overdue: false };
  return { next, overdue: false };
}

// Time of the next alarm. Civil logs, rate limits, and sim quotas are not included.
export function nextAlarmAt(sql: Sql, nowMs: number): number | undefined {
  let next: number | undefined;
  let overdue = false;
  const add = (at: number | undefined) => {
    const step = consider(next, at, nowMs);
    next = step.next;
    overdue = overdue || step.overdue;
  };
  add(optionalTime(one(sql, "SELECT MIN(expires_at) AS t FROM nonces")?.t));
  add(optionalTime(one(sql, "SELECT MIN(expires_at) AS t FROM actions")?.t));
  add(optionalTime(one(sql, "SELECT value AS t FROM meta WHERE key = ?", SEAT_RESET_KEY)?.t));
  for (const row of sql.exec("SELECT state FROM people").toArray()) {
    let times: number[] = [];
    try {
      const state = JSON.parse(String(row.state)) as StoredPersonState;
      if (state.current) times.push(state.current.expiresAt * 1000);
      for (const item of state.finished ?? []) times.push(item.expiresAt * 1000);
    } catch {
      times = [];
    }
    if (times.length === 0) overdue = true;
    for (const at of times) add(at);
  }
  if (next === undefined && overdue) return nowMs + 60_000;
  return next;
}
