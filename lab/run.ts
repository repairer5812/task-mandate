import { withRandom } from "../scripts/seeded-random";
import { DAYS, PEOPLE, SEEDS, SITES } from "./config";
import { createQueue } from "./engine/loop";
import { mulberry32 } from "./engine/rng";
import { schedulePopulation } from "./engine/script";
import { attackerKeys, makeIdp, makeSites } from "./engine/world";
import { createLedger } from "./invariants/ledger";
import { runProperties } from "./property";
import { buildSummary, type PropertyResult, type SeedResult, seoulDay, writeLabResult } from "./report";

const ORIGIN = Date.parse("2026-12-01T00:00:00Z");

async function oneSeed(seed: number): Promise<SeedResult> {
  const started = performance.now();
  const snapshot = await withRandom(`lab-${seed}`, async () => {
    const clock = { ms: ORIGIN };
    const queue = createQueue(clock, "fake");
    const idp = await makeIdp();
    const sites = makeSites(clock, idp, 600);
    const ledger = createLedger(seed, sites, true);
    await schedulePopulation({ queue, clock, ledger, sites, idp, attacker: await attackerKeys(), people: PEOPLE, days: DAYS, origin: ORIGIN, rng: mulberry32(seed), strictAttacks: PEOPLE >= 200 });
    await queue.drain();
    return ledger.snapshot();
  });
  const elapsedMs = performance.now() - started;
  console.log(`seed ${seed}: requests ${snapshot.requests}, violations ${snapshot.violationCount}, ${(elapsedMs / 1000).toFixed(1)}s`);
  return { seed, elapsedMs, snapshot };
}

const startedAt = new Date().toISOString();
const wall = performance.now();
const seeds: SeedResult[] = [];
for (let seed = 1; seed <= SEEDS; seed += 1) seeds.push(await oneSeed(seed));
let properties: PropertyResult;
try {
  properties = await runProperties();
} catch (error) {
  const message = error instanceof Error ? error.message : "property test failed";
  properties = { tamper: { runs: 0, allowed: 0, threw: 1 }, time: { runs: 0, mismatches: 1, boundaryFails: [message.slice(0, 500)] } };
  console.error(message);
}
const finishedAt = new Date().toISOString();
const summary = buildSummary({ startedAt, finishedAt, elapsedMs: Math.round(performance.now() - wall), people: PEOPLE, days: DAYS, sites: SITES.length, seeds, properties });
const dir = `lab/results/${seoulDay()}`;
await writeLabResult(dir, summary);
console.log(`${dir} requests ${summary.requests}, violations ${summary.violationCount}, ${(summary.elapsedMs / 1000).toFixed(1)}s`);
