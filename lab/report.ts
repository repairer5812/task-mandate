import { mkdir, writeFile } from "node:fs/promises";
import type { LedgerSnapshot, StoreSize, Violation } from "./invariants/ledger";

export interface SeedResult {
  seed: number;
  elapsedMs: number;
  snapshot: LedgerSnapshot;
}

export interface PropertyResult {
  tamper: { runs: number; allowed: number; threw: number };
  time: { runs: number; mismatches: number; boundaryFails: string[] };
}

export function seoulDay(date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))] ?? 0;
}

function addCount(target: Record<string, number>, source: Record<string, number>): void {
  for (const [key, value] of Object.entries(source)) target[key] = (target[key] ?? 0) + value;
}

function addNested(target: Record<string, Record<string, number>>, source: Record<string, Record<string, number>>): void {
  for (const [group, row] of Object.entries(source)) {
    let dest = target[group];
    if (!dest) {
      dest = {};
      target[group] = dest;
    }
    addCount(dest, row);
  }
}

function emptySize(): StoreSize {
  return { nonces: 0, actions: 0, people: 0 };
}

export interface Summary {
  startedAt: string;
  finishedAt: string;
  elapsedMs: number;
  people: number;
  seeds: number;
  days: number;
  sites: number;
  tasks: number;
  attacks: number;
  requests: number;
  allows: number;
  denies: number;
  reasons: Record<string, number>;
  violations: Violation[];
  violationCount: number;
  legitimate: Record<string, Record<string, number>>;
  bugCandidate: Record<string, Record<string, number>>;
  attackCodes: Record<string, Record<string, number>>;
  issueRejected: Record<string, number>;
  latencyMs: { p50: number; p95: number; max: number };
  storeMax: StoreSize;
  storeFinal: StoreSize;
  perSeed: { seed: number; elapsedMs: number; requests: number; violationCount: number }[];
  properties: PropertyResult;
}

export function buildSummary(input: { startedAt: string; finishedAt: string; elapsedMs: number; people: number; days: number; sites: number; seeds: SeedResult[]; properties: PropertyResult }): Summary {
  const reasons: Record<string, number> = {};
  const legitimate: Record<string, Record<string, number>> = {};
  const bugCandidate: Record<string, Record<string, number>> = {};
  const attackCodes: Record<string, Record<string, number>> = {};
  const issueRejected: Record<string, number> = {};
  const violations: Violation[] = [];
  const latencies: number[] = [];
  const storeMax = emptySize();
  const storeFinal = emptySize();
  let tasks = 0;
  let attacks = 0;
  let requests = 0;
  let allows = 0;
  let denies = 0;
  let violationCount = 0;
  for (const seed of input.seeds) {
    const row = seed.snapshot;
    tasks += row.tasks;
    attacks += row.attacks;
    requests += row.requests;
    allows += row.allows;
    denies += row.denies;
    violationCount += row.violationCount;
    addCount(reasons, row.reasons);
    addNested(legitimate, row.legitimate);
    addNested(bugCandidate, row.bugCandidate);
    addNested(attackCodes, row.attackCodes);
    addCount(issueRejected, row.issueRejected);
    violations.push(...row.violations);
    latencies.push(...row.latencies);
    storeMax.nonces = Math.max(storeMax.nonces, row.storeMax.nonces);
    storeMax.actions = Math.max(storeMax.actions, row.storeMax.actions);
    storeMax.people = Math.max(storeMax.people, row.storeMax.people);
    if (row.storeFinal) {
      storeFinal.nonces = Math.max(storeFinal.nonces, row.storeFinal.nonces);
      storeFinal.actions = Math.max(storeFinal.actions, row.storeFinal.actions);
      storeFinal.people = Math.max(storeFinal.people, row.storeFinal.people);
    }
  }
  return {
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    elapsedMs: input.elapsedMs,
    people: input.people,
    seeds: input.seeds.length,
    days: input.days,
    sites: input.sites,
    tasks,
    attacks,
    requests,
    allows,
    denies,
    reasons,
    violations,
    violationCount,
    legitimate,
    bugCandidate,
    attackCodes,
    issueRejected,
    latencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95), max: percentile(latencies, 100) },
    storeMax,
    storeFinal,
    perSeed: input.seeds.map((seed) => ({ seed: seed.seed, elapsedMs: Math.round(seed.elapsedMs), requests: seed.snapshot.requests, violationCount: seed.snapshot.violationCount })),
    properties: input.properties,
  };
}

function countTable(title: string, rows: Record<string, number>): string {
  const keys = Object.keys(rows).sort();
  if (keys.length === 0) return `## ${title}\n\nNone.\n`;
  const body = keys.map((key) => `| ${key} | ${rows[key]} |`).join("\n");
  return `## ${title}\n\n| Item | Count |\n| --- | ---: |\n${body}\n`;
}

function nestedTable(title: string, rows: Record<string, Record<string, number>>): string {
  const lines: string[] = [];
  for (const group of Object.keys(rows).sort()) {
    const inner = rows[group] ?? {};
    for (const code of Object.keys(inner).sort()) lines.push(`| ${group} | ${code} | ${inner[code]} |`);
  }
  if (lines.length === 0) return `## ${title}\n\nNone.\n`;
  return `## ${title}\n\n| Category | Code | Count |\n| --- | --- | ---: |\n${lines.join("\n")}\n`;
}

export function renderReport(summary: Summary): string {
  const violationRows = summary.violations.length === 0 ? "None." : ["| Seed | Rule | Time (s) | Detail |", "| ---: | --- | ---: | --- |"].concat(summary.violations.map((row) => `| ${row.seed} | ${row.rule} | ${row.atSec} | ${row.detail} |`)).join("\n");
  const seedRows = ["| Seed | Requests | Violations | Time (ms) |", "| ---: | ---: | ---: | ---: |"].concat(summary.perSeed.map((row) => `| ${row.seed} | ${row.requests} | ${row.violationCount} | ${row.elapsedMs} |`)).join("\n");
  const seconds = (summary.elapsedMs / 1000).toFixed(1);
  return [
    "# Lab results",
    "",
    `Ran in-process. ${summary.seeds} seeds, ${summary.people} people, ${summary.days} simulated days, ${summary.sites} sites.`,
    `Started ${summary.startedAt}, finished ${summary.finishedAt}, elapsed ${seconds}s.`,
    "",
    "## Scenarios and requests",
    "",
    `Task scenarios ${summary.tasks}, attack scenarios ${summary.attacks}.`,
    `Requests ${summary.requests}, allowed ${summary.allows}, denied ${summary.denies}.`,
    "",
    countTable("Reason codes", summary.reasons).trimEnd(),
    "",
    "## Invariant violations",
    "",
    `${summary.violationCount} violations. At most two examples of the same rule are kept per seed. The count includes every hit. The event log is in summary.json.`,
    "",
    violationRows,
    "",
    nestedTable("Legitimate request denials, by design", summary.legitimate).trimEnd(),
    "",
    nestedTable("Legitimate request denials, bug candidates", summary.bugCandidate).trimEnd(),
    "",
    nestedTable("Attack reason codes", summary.attackCodes).trimEnd(),
    "",
    countTable("Rejected at issue", summary.issueRejected).trimEnd(),
    "",
    "## Latency",
    "",
    `p50 ${summary.latencyMs.p50.toFixed(2)}ms, p95 ${summary.latencyMs.p95.toFixed(2)}ms, max ${summary.latencyMs.max.toFixed(2)}ms.`,
    "",
    "## Store",
    "",
    `Peak nonces ${summary.storeMax.nonces}, actions ${summary.storeMax.actions}, people ${summary.storeMax.people}.`,
    `After finish, nonces ${summary.storeFinal.nonces}, actions ${summary.storeFinal.actions}, people ${summary.storeFinal.people}.`,
    "",
    "## Property tests",
    "",
    `Mandate tamper ${summary.properties.tamper.runs} runs, allowed ${summary.properties.tamper.allowed}, exceptions ${summary.properties.tamper.threw}.`,
    `Time order ${summary.properties.time.runs} runs, mismatches ${summary.properties.time.mismatches}, boundary failures ${summary.properties.time.boundaryFails.length}.`,
    "",
    "## By seed",
    "",
    seedRows,
    "",
    "## Not checked here",
    "",
    "Durable Object concurrency and the real clock are recorded in the lab:worker result. Store size in this file is the in-memory store only.",
    "",
  ].join("\n");
}

export async function writeLabResult(dir: string, summary: Summary): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(`${dir}/summary.json`, `${JSON.stringify(summary, null, 2)}\n`);
  await writeFile(`${dir}/report.md`, renderReport(summary));
}
