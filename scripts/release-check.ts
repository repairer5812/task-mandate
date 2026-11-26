import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { runPackExample } from "./release/pack.js";
import { runSupply } from "./release/supply.js";

const root = path.resolve(import.meta.dirname, "..");

interface Row {
  id: string;
  result: "Pass" | "Fail";
  detail: string;
}

function run(command: string, args: string[], env?: NodeJS.ProcessEnv): { code: number; out: string } {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 });
  return { code: result.status ?? 1, out: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

function failedTests(text: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("FAIL ") || /^\d+ failed/.test(line) || line.includes("failed ("));
  const unique = [...new Set(lines)];
  return (unique.length > 0 ? unique : [tail(text)]).join(" / ").slice(0, 900);
}

const ansiColor = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, "g");

function tail(text: string, lines = 12): string {
  return text.trim().split("\n").slice(-lines).join(" ").slice(0, 500);
}

interface CiRun {
  conclusion: string | null;
  status: string;
  headSha?: string;
}

function parseJson<T>(text: string): T {
  const raw = text.replace(ansiColor, "").trim();
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end < start) throw new Error("no JSON");
  return JSON.parse(raw.slice(start, end + 1)) as T;
}

function ciRuns(branch: string): { ok: true; runs: CiRun[] } | { ok: false; detail: string } {
  const listed = run("gh", ["run", "list", "--branch", branch, "--workflow", "ci.yml", "--limit", "15", "--json", "conclusion,status,headSha"], { FORCE_COLOR: "0", NO_COLOR: "1" });
  if (listed.code !== 0 || listed.out.trim() === "") return { ok: false, detail: `${branch} CI list failed` };
  try {
    return { ok: true, runs: parseJson<CiRun[]>(listed.out) };
  } catch {
    return { ok: false, detail: `${branch} CI list JSON parse failed` };
  }
}

function mainCi(): { ok: boolean; detail: string } {
  const listed = ciRuns("main");
  if (!listed.ok) return listed;
  const done = listed.runs.filter((item) => item.status === "completed");
  if (done.length === 0) return { ok: false, detail: "no completed CI on main" };
  if (done[0]?.conclusion !== "success") return { ok: false, detail: `latest main CI ${done[0]?.conclusion ?? "failed"}` };
  return { ok: true, detail: "latest main CI passed" };
}

function ciForCommit(sha: string): { ok: true; runs: CiRun[] } | { ok: false; detail: string } {
  const listed = run("gh", ["run", "list", "--commit", sha, "--workflow", "ci.yml", "--limit", "15", "--json", "conclusion,status,headSha"], { FORCE_COLOR: "0", NO_COLOR: "1" });
  if (listed.code !== 0 || listed.out.trim() === "") return { ok: false, detail: `${sha} CI list failed` };
  try {
    return { ok: true, runs: parseJson<CiRun[]>(listed.out) };
  } catch {
    return { ok: false, detail: `${sha} CI list JSON parse failed` };
  }
}

function headCi(): { ok: boolean; detail: string } {
  const head = run("git", ["rev-parse", "HEAD"]);
  if (head.code !== 0) return { ok: false, detail: "could not read git HEAD" };
  const sha = head.out.trim();
  const listed = ciForCommit(sha);
  if (!listed.ok) return listed;
  const mine = listed.runs.filter((item) => item.headSha === sha);
  if (mine.length === 0) return { ok: false, detail: "no CI record for this commit" };
  if (mine.some((item) => item.status !== "completed")) return { ok: false, detail: "CI for this commit is still running" };
  if (mine.some((item) => item.conclusion !== "success")) return { ok: false, detail: "CI for this commit failed" };
  return { ok: true, detail: "CI for this commit passed" };
}

function ciCheck(): Row {
  const steps = [
    ["pnpm", ["build"]],
    ["pnpm", ["test"]],
    ["pnpm", ["test:worker"]],
    ["pnpm", ["typecheck"]],
  ] as const;
  const failed: string[] = [];
  for (const [command, args] of steps) {
    const result = run(command, [...args]);
    if (result.code !== 0) failed.push(`${args[0]}: ${args[0] === "test" ? failedTests(result.out) : tail(result.out, 8)}`);
  }
  const main = mainCi();
  const head = headCi();
  if (!main.ok) failed.push(main.detail);
  if (!head.ok) failed.push(head.detail);
  const ci = [main.detail, head.detail].filter((item, index, all) => all.indexOf(item) === index).join(", ");
  return { id: "ci", result: failed.length === 0 ? "Pass" : "Fail", detail: failed.length === 0 ? ci : `${failed.join(" | ")} / ${ci}` };
}

function vectorsCheck(): Row {
  const generated = run("pnpm", ["vectors"]);
  if (generated.code !== 0) return { id: "vectors", result: "Fail", detail: tail(generated.out) };
  const diff = run("git", ["diff", "--exit-code", "--", "vectors"]);
  if (diff.code !== 0) run("git", ["checkout", "--", "vectors"]);
  return { id: "vectors", result: diff.code === 0 ? "Pass" : "Fail", detail: diff.code === 0 ? "vectors diff 0" : "vectors differ after pnpm vectors. Restored the files." };
}

function countOf(rows: Record<string, number> | undefined): number {
  return Object.values(rows ?? {}).reduce((sum, value) => sum + value, 0);
}

async function labCheck(): Promise<Row> {
  const result = run("pnpm", ["lab"]);
  const file = path.join(root, "lab/results", seoulDay(), "summary.json");
  let summary: { seeds?: number; people?: number; days?: number; sites?: number; violationCount?: number; bugCandidate?: Record<string, Record<string, number>>; storeFinal?: { nonces: number; actions: number; people: number } };
  try {
    summary = JSON.parse(await readFile(file, "utf8")) as typeof summary;
  } catch {
    return { id: "lab", result: "Fail", detail: result.code === 0 ? "summary.json missing" : tail(result.out) };
  }
  const problems: string[] = [];
  if ((summary.seeds ?? 0) < 20 || (summary.people ?? 0) < 200 || (summary.days ?? 0) < 7 || (summary.sites ?? 0) < 3) {
    problems.push(`scale ${summary.seeds}/${summary.people}/${summary.days}/${summary.sites}`);
  }
  if ((summary.violationCount ?? 1) !== 0) problems.push(`violations ${summary.violationCount}`);
  const unexplained = countOf(summary.bugCandidate?.["unexpected deny"]);
  const attackCode = countOf(summary.bugCandidate?.["attack code"]);
  if (unexplained !== 0) problems.push(`unexpected deny ${unexplained}`);
  if (attackCode !== 0) problems.push(`attack code ${attackCode}`);
  const store = summary.storeFinal;
  if (store?.nonces !== 0 || store?.actions !== 0 || store?.people !== 0) problems.push("store rows left");
  return { id: "lab", result: problems.length === 0 && result.code === 0 ? "Pass" : "Fail", detail: problems.length === 0 ? "invariants 0" : problems.join(", ") };
}

async function labWorkerCheck(): Promise<Row> {
  const result = run("pnpm", ["lab:worker"], { LAB_WORKER_REPEATS: "20" });
  const file = path.join(root, "lab/results", seoulDay(), "worker/summary.json");
  try {
    const body = JSON.parse(await readFile(file, "utf8")) as { repeats?: number; violationCount?: number; concurrency?: { burst?: { allows?: number; maxActions?: number }; nonce?: { allows?: number }; person?: { allows?: number } }; scenario?: { violationCount?: number } };
    const problems: string[] = [];
    if ((body.repeats ?? 0) < 20) problems.push(`repeats ${body.repeats}`);
    if ((body.violationCount ?? 1) !== 0) problems.push(`concurrency violations ${body.violationCount}`);
    if ((body.scenario?.violationCount ?? 1) !== 0) problems.push(`scenario violations ${body.scenario?.violationCount}`);
    const burst = body.concurrency?.burst;
    if ((burst?.allows ?? 99) > (burst?.maxActions ?? 0)) problems.push("count");
    if (body.concurrency?.nonce?.allows !== 1) problems.push("nonce");
    if ((body.concurrency?.person?.allows ?? 2) > 1) problems.push("person slot");
    return { id: "lab-worker", result: problems.length === 0 && result.code === 0 ? "Pass" : "Fail", detail: problems.length === 0 ? "20 runs, 0 violations" : problems.join(", ") };
  } catch {
    return { id: "lab-worker", result: "Fail", detail: tail(result.out) };
  }
}

function propertyCheck(): Row {
  const result = run("pnpm", ["exec", "vitest", "run", "--config", "lab/vitest.config.ts", "lab/property.test.ts"]);
  const runs = result.out.includes("1000") || result.code === 0;
  return { id: "property", result: result.code === 0 && runs ? "Pass" : "Fail", detail: result.code === 0 ? "property 1,000 runs or more" : tail(result.out) };
}

function seoulDay(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function hygieneCheck(): Row {
  const result = run("pnpm", ["exec", "vitest", "run", "tests/acceptance-repo-hygiene.test.ts"]);
  if (result.code !== 0) return { id: "hygiene", result: "Fail", detail: failedTests(result.out) };
  return { id: "hygiene", result: "Pass", detail: "no Hangul in published packages, tutorial comments 0, banned phrases 0, Biome, duplication at most 1%, allow list" };
}

async function orderChangelogCheck(): Promise<Row> {
  const order = run("pnpm", ["exec", "vitest", "run", "packages/core/test/check-order.test.ts"]);
  const changelog = await readFile(path.join(root, "CHANGELOG.md"), "utf8");
  const problems: string[] = [];
  if (order.code !== 0) problems.push("check-order test failed");
  if (!changelog.includes("0.1.0")) problems.push("CHANGELOG has no 0.1.0");
  return { id: "order-changelog", result: problems.length === 0 ? "Pass" : "Fail", detail: problems.length === 0 ? "order test, CHANGELOG 0.1.0" : problems.join(", ") };
}

async function take(id: string, make: () => Row | Promise<Row>): Promise<Row> {
  try {
    return await make();
  } catch (error) {
    const message = error instanceof Error ? error.message : "exception";
    return { id, result: "Fail", detail: message.slice(0, 300) };
  }
}

const rows: Array<Row | "manual"> = [];
rows.push(await take("ci", () => ciCheck()));
rows.push(await take("vectors", () => vectorsCheck()));
rows.push(await take("lab", () => labCheck()));
rows.push(await take("lab-worker", () => labWorkerCheck()));
rows.push(await take("property", () => propertyCheck()));
rows.push(
  await take("pack", async () => {
    const packed = await runPackExample(root);
    return { id: "pack", result: /^installed \d+/.test(packed) ? "Pass" : "Fail", detail: packed };
  }),
);
rows.push(
  await take("supply", () => {
    const supply = runSupply(root);
    return { id: "supply", result: supply === undefined ? "Pass" : "Fail", detail: supply ?? "audit, licenses, and secrets 0" };
  }),
);
rows.push("manual");
rows.push(await take("order-changelog", () => orderChangelogCheck()));
rows.push(await take("hygiene", () => hygieneCheck()));

console.log("| ID | Result | Detail |");
console.log("| --- | --- | --- |");
for (const row of rows) {
  if (row === "manual") {
    console.log("manual: try the deployed /sim");
    continue;
  }
  console.log(`| ${row.id} | ${row.result} | ${row.detail.replaceAll("|", "/").replaceAll("\n", " ")} |`);
}
if (rows.some((row) => row !== "manual" && row.result === "Fail")) process.exit(1);
