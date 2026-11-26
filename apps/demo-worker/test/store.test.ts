import { runInDurableObject } from "cloudflare:test";
import { env } from "cloudflare:workers";
import type { Store } from "@task-mandate/core";
import { advanceAction, digestKey } from "@task-mandate/core/internal";
import { defineStoreConformance } from "@task-mandate/store-conformance";
import { describe, expect, it } from "vitest";
import type { MandateStore } from "../src/store";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function stub(name: string): DurableObjectStub<MandateStore> {
  const id = env.MANDATE_STORE.idFromName(name);
  return env.MANDATE_STORE.get(id);
}

function storeFrom(object: DurableObjectStub<MandateStore>): Store {
  return { claimNonce: (nonce, ttlSec) => object.claimNonce(nonce, ttlSec), consumeAction: (key, max, ttlSec) => object.consumeAction(key, max, ttlSec), refundAction: (key) => object.refundAction(key), claimPersonSlot: (input) => object.claimPersonSlot(input) };
}

function makeStore(): Store {
  return storeFrom(stub(`store-${crypto.randomUUID()}`));
}

function makePair(): readonly [Store, Store] {
  const object = stub(`store-${crypto.randomUUID()}`);
  return [storeFrom(object), storeFrom(object)];
}

defineStoreConformance("MandateStore", makeStore, { makePair });

describe("MandateStore alarm", () => {
  it("deletes expired nonces", async () => {
    const object = stub("alarm-nonce");
    expect(await object.claimNonce("gone", 1)).toBe(true);
    expect(await object.claimNonce("stay", 60)).toBe(true);
    await sleep(1100);
    const left = await runInDurableObject(object, async (instance, state) => {
      await instance.alarm();
      const rows = state.storage.sql.exec("SELECT COUNT(*) AS n FROM nonces").toArray();
      return Number(rows[0]?.n ?? 0);
    });
    expect(left).toBe(1);
    expect(await object.claimNonce("gone", 60)).toBe(true);
    expect(await object.claimNonce("stay", 60)).toBe(false);
  });

  it("rearms the alarm only when there are rows to clean or a seat restore time", async () => {
    const fresh = stub("alarm-fresh");
    expect(await alarmAt(fresh)).toBeNull();

    const live = stub("alarm-live");
    expect(await live.claimNonce("stay", 60)).toBe(true);
    const armed = await alarmAt(live);
    expect(armed).not.toBeNull();
    expect(armed!).toBeGreaterThan(Date.now());
    await runInDurableObject(live, async (instance) => {
      await instance.alarm();
    });
    expect(await alarmAt(live)).not.toBeNull();

    const gone = stub("alarm-gone");
    expect(await gone.claimNonce("short", 1)).toBe(true);
    await sleep(1100);
    const cleared = await runInDurableObject(gone, async (instance, state) => {
      await instance.alarm();
      const rows = state.storage.sql.exec("SELECT COUNT(*) AS n FROM nonces").toArray();
      return { left: Number(rows[0]?.n ?? 0), alarm: await state.storage.getAlarm() };
    });
    expect(cleared.left).toBe(0);
    expect(cleared.alarm).toBeNull();
    expect(await gone.claimNonce("again", 60)).toBe(true);
    expect(await alarmAt(gone)).not.toBeNull();
  });
});

async function alarmAt(object: DurableObjectStub<MandateStore>): Promise<number | null> {
  return runInDurableObject(object, (_instance, state) => state.storage.getAlarm());
}

describe("store expiry boundary", () => {
  it("TTL 0 is not consumed, and a row in its expiry second can be written again", async () => {
    expect(advanceAction({ count: 2, expiresAt: 1_000 }, 1_000, 5, 60)).toMatchObject({ allowed: true, row: { count: 1 } });
    expect(advanceAction(undefined, 1_000, 5, 0).allowed).toBe(false);
    const object = stub("ttl-boundary");
    expect(await object.consumeAction("zero", 5, 0)).toBe(false);
    expect(await object.consumeAction("zero", 5, 0)).toBe(false);
    expect(await object.consumeAction("live", 1, 1)).toBe(true);
    await sleep(1100);
    expect(await object.consumeAction("live", 1, 1)).toBe(true);
  });

  it("a person slot expires by the verification time", async () => {
    const object = stub("person-clock");
    const now = 2_000_000_000;
    const first = { personKey: "idp\u0000p", taskKey: "t1", agentKeyId: "a", taskBegin: now, expiresAt: now + 3_600, now, minSwitchSec: 600 };
    expect(await object.claimPersonSlot(first)).toBe("ok");
    expect(await object.claimPersonSlot({ ...first, taskKey: "t2", agentKeyId: "b", taskBegin: now + 10, now: now + 10 })).toBe("superseded");
  });

  it("a seat can be released after it is taken", async () => {
    const object = stub("seat-release");
    expect(await object.takeSeat("court-3")).toMatchObject({ status: "ok" });
    const before = (await object.listSeats())["court-3"];
    await object.releaseSeat("court-3");
    expect((await object.listSeats())["court-3"]).toBe((before ?? 0) + 1);
  });
});

describe("seat restore", () => {
  it("after SEAT_RESET_SEC, seat counts return to the configured values, and before that only the alarm stays", async () => {
    const object = stub("seat-restore");
    expect((await object.listSeats())["court-4"]).toBe(1);
    expect(await object.takeSeat("court-4")).toMatchObject({ status: "ok", remaining: 0 });
    const armed = await alarmAt(object);
    expect(armed).not.toBeNull();
    expect(armed!).toBeGreaterThan(Date.now() + 3_000_000);

    await runInDurableObject(object, async (instance) => {
      await instance.alarm();
    });
    expect((await object.listSeats())["court-4"]).toBe(0);
    expect(await alarmAt(object)).not.toBeNull();

    await runInDurableObject(object, async (instance, state) => {
      state.storage.sql.exec("UPDATE meta SET value = ? WHERE key = 'seat_reset_at'", Date.now() - 1000);
      await instance.alarm();
    });
    expect((await object.listSeats())["court-4"]).toBe(1);
    expect((await object.listSeats())["court-3"]).toBe(1000);
    expect(await alarmAt(object)).toBeNull();
  });
});

describe("civil log", () => {
  it("keeps only 50 lines, reset clears them, and no alarm is set", async () => {
    const object = stub("civil-rows");
    expect(await alarmAt(object)).toBeNull();
    for (let i = 0; i < 55; i++) {
      await object.appendCivil({ at: String(i).padStart(3, "0"), status: 401, code: "NO_MANDATE", service: "basic-pension", task: null });
    }
    const entries = await object.recentCivil();
    expect(entries).toHaveLength(50);
    expect(entries[0]?.at).toBe("054");
    expect(entries[49]?.at).toBe("005");
    expect(await alarmAt(object)).toBeNull();
    await object.reset();
    expect(await object.recentCivil()).toEqual([]);
    expect(await alarmAt(object)).toBeNull();
  });
});

describe("sim limits", () => {
  it("rejects past 3 LLM calls and 30 per day, reset clears them, and no alarm is set", async () => {
    const object = stub("sim-limit");
    const now = Date.now();
    const ip = "203.0.113.70";
    expect(await alarmAt(object)).toBeNull();
    for (let i = 0; i < 3; i++) expect(await object.hitSimLlm(ip, now, 3, 600)).toBe(true);
    expect(await object.hitSimLlm(ip, now, 3, 600)).toBe(false);
    for (let i = 0; i < 10; i++) expect(await object.hitSimAttest(ip, now, 10, 600)).toBe(true);
    expect(await object.hitSimAttest(ip, now, 10, 600)).toBe(false);
    for (let i = 0; i < 30; i++) expect(await object.takeSimBudget("2026-12-18", 30)).toBe(true);
    expect(await object.takeSimBudget("2026-12-18", 30)).toBe(false);

    const dump = await runInDurableObject(object, (_instance, state) => {
      const llm = state.storage.sql.exec("SELECT client_key FROM sim_llm_limit").toArray();
      const attest = state.storage.sql.exec("SELECT client_key FROM sim_attest_limit").toArray();
      return { llm, attest };
    });
    const blob = JSON.stringify(dump);
    expect(blob).not.toContain(ip);
    expect(dump.llm.map((row) => String(row.client_key))).toContain(await digestKey(ip));
    expect(dump.attest.map((row) => String(row.client_key))).toContain(await digestKey(ip));
    expect(await alarmAt(object)).toBeNull();

    await object.reset();
    expect(await object.hitSimLlm(ip, now, 3, 600)).toBe(true);
    expect(await object.hitSimAttest(ip, now, 10, 600)).toBe(true);
    expect(await object.takeSimBudget("2026-12-18", 30)).toBe(true);
    expect(await alarmAt(object)).toBeNull();
  });
});

describe("digest keys", () => {
  it("does not store plaintext nonces, action keys, or person keys, and deletes the row when the count is 0", async () => {
    const object = stub("digest-keys");
    const nonce = "PLAINTEXT-nonce";
    const action = "PLAINTEXT-action";
    const person = "idp\u0000PLAINTEXT-person";
    const task = "PLAINTEXT-task";
    const now = Math.floor(Date.now() / 1000);
    expect(await object.claimNonce(nonce, 60)).toBe(true);
    expect(await object.consumeAction(action, 2, 60)).toBe(true);
    expect(await object.consumeAction(action, 2, 60)).toBe(true);
    expect(await object.claimPersonSlot({ personKey: person, taskKey: task, agentKeyId: "a1", taskBegin: now - 10, expiresAt: now + 3600, now, minSwitchSec: 600 })).toBe("ok");

    const dump = await runInDurableObject(object, (_instance, state) => {
      const nonces = state.storage.sql.exec("SELECT nonce FROM nonces").toArray();
      const actions = state.storage.sql.exec("SELECT key, count FROM actions").toArray();
      const people = state.storage.sql.exec("SELECT person_key, state FROM people").toArray();
      return { nonces, actions, people };
    });
    const blob = JSON.stringify(dump);
    expect(blob).not.toContain("PLAINTEXT");
    expect(dump.nonces.map((row) => String(row.nonce))).toContain(await digestKey(nonce));
    expect(dump.actions.map((row) => String(row.key))).toContain(await digestKey(action));
    expect(dump.people.map((row) => String(row.person_key))).toContain(await digestKey(person));
    expect(String(dump.people[0]?.state)).toContain(await digestKey(task));
    expect(Number(dump.actions[0]?.count)).toBe(2);

    await object.refundAction(action);
    await object.refundAction(action);
    const left = await runInDurableObject(object, (_instance, state) => {
      const rows = state.storage.sql.exec("SELECT COUNT(*) AS n FROM actions").toArray();
      return Number(rows[0]?.n ?? 0);
    });
    expect(left).toBe(0);
  });
});
