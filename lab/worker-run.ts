import { mkdir, writeFile } from "node:fs/promises";
import { ed25519 } from "../bench/keys";
import { WORKER_MS } from "./config";
import type { Site } from "./engine/types";
import { percentile, seoulDay } from "./report";
import { runConcurrency } from "./worker/concurrency";
import { type DevServer, startWorker } from "./worker/dev-server";
import { liveScale, runLiveScenario } from "./worker/scenario";

function siteFor(server: DevServer): Site {
  return {
    id: "local",
    origin: server.origin,
    minSwitchSec: server.minSwitchSec,
    async request(input) {
      const url = new URL(input.url);
      if (url.origin !== server.origin) throw new Error(`target is not local: ${url.origin}`);
      const response = await fetch(input, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel();
        throw new Error(`not following redirect: ${response.status}`);
      }
      return response;
    },
  };
}

function countText(rows: Record<string, number>): string {
  const keys = Object.keys(rows).sort();
  if (keys.length === 0) return "none";
  return keys.map((key) => `${key} ${rows[key]}`).join(", ");
}

const started = Date.now();
const scale = liveScale(WORKER_MS);
const repeats = Math.max(1, Number(process.env.LAB_WORKER_REPEATS ?? "1") || 1);
const idp = await ed25519();
const principal = await ed25519();
const agents = [await ed25519(), await ed25519()] as [typeof principal, typeof principal];
const server = await startWorker(idp, scale.minSwitchSec);
try {
  const site = siteFor(server);
  const rounds = [];
  for (let index = 0; index < repeats; index += 1) {
    if (index > 0) await server.reset();
    rounds.push(await runConcurrency(server, site, idp, principal, agents));
  }
  const concurrency = rounds[0]!;
  const violations = rounds.flatMap((round) => round.violations);
  await server.reset();
  const ledger = await runLiveScenario({ site, idp, scale });
  const snapshot = ledger.snapshot();
  const elapsedMs = Date.now() - started;
  const body = {
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date().toISOString(),
    elapsedMs,
    originHost: "127.0.0.1",
    minSwitchSec: scale.minSwitchSec,
    chunkSec: scale.chunkSec,
    renewSpanSec: scale.renewSpanSec,
    storeMeasured: false,
    note: "Durable Object store size was not measured. Memory store growth is checked only in the in-process test.",
    repeats,
    concurrency,
    violationCount: violations.length,
    scenario: {
      requests: snapshot.requests,
      allows: snapshot.allows,
      denies: snapshot.denies,
      reasons: snapshot.reasons,
      violationCount: snapshot.violationCount,
      violations: snapshot.violations,
      legitimate: snapshot.legitimate,
      bugCandidate: snapshot.bugCandidate,
      latencyMs: { p50: percentile(snapshot.latencies, 50), p95: percentile(snapshot.latencies, 95) },
    },
  };
  const dir = `lab/results/${seoulDay()}`;
  const workerDir = `${dir}/worker`;
  await mkdir(workerDir, { recursive: true });
  await writeFile(`${dir}/worker.json`, `${JSON.stringify(body, null, 2)}\n`);
  await writeFile(`${workerDir}/summary.json`, `${JSON.stringify(body, null, 2)}\n`);
  const lines = [
    "# Worker concurrency test",
    "",
    `Local wrangler dev, real clock. Concurrency ${repeats} times, one run over time. Elapsed ${(elapsedMs / 1000).toFixed(1)}s.`,
    `Renewal chunk ${scale.chunkSec}s, renewal task ${scale.renewSpanSec}s, minimum switch ${scale.minSwitchSec}s.`,
    "",
    `50 concurrent requests, limit ${concurrency.burst.maxActions}, allowed ${concurrency.burst.allows}. Codes: ${countText(concurrency.burst.codes)}.`,
    `Same nonce allowed ${concurrency.nonce.allows}. Codes: ${countText(concurrency.nonce.codes)}.`,
    `Same person concurrent allowed ${concurrency.person.allows}. Codes: ${countText(concurrency.person.codes)}.`,
    "",
    violations.length === 0 ? "No concurrency violations." : violations.map((row) => `${row.rule}: ${row.detail}`).join("\n"),
    "",
    `Requests over time ${snapshot.requests}, allowed ${snapshot.allows}, denied ${snapshot.denies}, violations ${snapshot.violationCount}.`,
    `p50 ${percentile(snapshot.latencies, 50).toFixed(2)}ms, p95 ${percentile(snapshot.latencies, 95).toFixed(2)}ms.`,
    "",
    "Whether the store grows over time was not measured in this mode.",
    "",
  ];
  await writeFile(`${dir}/worker.md`, lines.join("\n"));
  console.log(`${dir}/worker.json concurrency ${repeats} times, violations ${violations.length}, scenario violations ${snapshot.violationCount}`);
} finally {
  await server.stop();
}
