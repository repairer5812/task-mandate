import { advanceCivilWindow, civilWindowCutoff } from "@task-mandate/demo-site";
import type { Sql } from "./sql-store.js";

const SIM_SCHEMA = `
CREATE TABLE IF NOT EXISTS sim_llm_limit (
  client_key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sim_attest_limit (
  client_key TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sim_budget (
  day_key TEXT PRIMARY KEY,
  count INTEGER NOT NULL
);
`;

const WINDOWS = new Set(["sim_llm_limit", "sim_attest_limit"]);

export type SimWindow = "sim_llm_limit" | "sim_attest_limit";

function num(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) throw new Error("stored value is not a number");
  return parsed;
}

function one(sql: Sql, query: string, ...bindings: unknown[]): Record<string, unknown> | undefined {
  return sql.exec(query, ...bindings).toArray()[0];
}

export function ensureSimSchema(sql: Sql): void {
  sql.exec(SIM_SCHEMA);
}

export function clearSimTables(sql: Sql): void {
  sql.exec("DELETE FROM sim_llm_limit");
  sql.exec("DELETE FROM sim_attest_limit");
  sql.exec("DELETE FROM sim_budget");
}

export function hitSimWindow(sql: Sql, table: SimWindow, storedKey: string, nowMs: number, limit: number, windowSec: number): boolean {
  if (!WINDOWS.has(table)) throw new Error("not a limit table");
  const cutoff = civilWindowCutoff(nowMs, windowSec);
  sql.exec(`DELETE FROM ${table} WHERE window_start <= ?`, cutoff);
  const row = one(sql, `SELECT window_start, count FROM ${table} WHERE client_key = ?`, storedKey);
  const current = row ? { startMs: num(row.window_start), count: num(row.count) } : undefined;
  const next = advanceCivilWindow(current, nowMs, limit, windowSec);
  sql.exec(`INSERT INTO ${table} (client_key, window_start, count) VALUES (?, ?, ?) ON CONFLICT(client_key) DO UPDATE SET window_start = excluded.window_start, count = excluded.count`, storedKey, next.row.startMs, next.row.count);
  return next.allowed;
}

export function takeSimBudget(sql: Sql, dayKey: string, max: number): boolean {
  const row = one(sql, "SELECT count FROM sim_budget WHERE day_key = ?", dayKey);
  const count = (row ? num(row.count) : 0) + 1;
  sql.exec("INSERT INTO sim_budget (day_key, count) VALUES (?, ?) ON CONFLICT(day_key) DO UPDATE SET count = excluded.count", dayKey, count);
  return count <= max;
}
