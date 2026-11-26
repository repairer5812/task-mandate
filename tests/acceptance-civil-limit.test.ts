// Acceptance tests for the civil-service application request limit. Do not edit to make a change pass.
import { describe, it, expect } from "vitest";
import { memoryStore } from "@task-mandate/core";
import { createApp, memoryCivilLog, memoryCivilLimiter } from "../apps/demo-site/src/app";

const SITE = "https://court.example";
const T0 = new Date("2026-12-01T00:00:00Z");

function setup() {
  let clock = T0;
  const now = () => clock;
  const app = createApp({
    origin: SITE,
    store: memoryStore({ now }),
    seats: { "court-3": 5 },
    civilLog: memoryCivilLog(),
    civilLimiter: memoryCivilLimiter({ limit: 20, windowSec: 60 }),
    now,
  });
  const apply = (ip?: string, body = JSON.stringify({ service: "basic-pension" })) =>
    app.request(
      new Request(`${SITE}/civil/apply`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(ip ? { "cf-connecting-ip": ip } : {}) },
        body,
      }),
    );
  const log = async () => (await (await app.request(`${SITE}/civil/log`)).json()).entries as unknown[];
  return { apply, log, advance: (sec: number) => (clock = new Date(clock.getTime() + sec * 1000)) };
}

describe("request limit", () => {
  it("the 21st application from one IP is 429 and is not logged", async () => {
    const { apply, log } = setup();
    for (let i = 0; i < 20; i++) expect((await apply("203.0.113.7")).status).toBe(401);
    const res = await apply("203.0.113.7");
    expect(res.status).toBe(429);
    expect((await res.json()).error).toBe("rate-limited");
    expect(await log()).toHaveLength(20);
  });

  it("a different IP has its own count", async () => {
    const { apply } = setup();
    for (let i = 0; i < 20; i++) await apply("203.0.113.7");
    expect((await apply("198.51.100.9")).status).toBe(401);
  });

  it("after the window, applications are accepted again", async () => {
    const { apply, advance } = setup();
    for (let i = 0; i < 21; i++) await apply("203.0.113.7");
    advance(61);
    expect((await apply("203.0.113.7")).status).toBe(401);
  });

  it("missing IP headers share one key", async () => {
    const { apply } = setup();
    for (let i = 0; i < 20; i++) await apply();
    expect((await apply()).status).toBe(429);
  });

  it("an oversized body is limited first", async () => {
    const { apply } = setup();
    const big = JSON.stringify({ service: "x", pad: "a".repeat(2000) });
    for (let i = 0; i < 20; i++) expect((await apply("203.0.113.7", big)).status).toBe(413);
    expect((await apply("203.0.113.7", big)).status).toBe(429);
  });

  it("listing services and reading the log are not limited", async () => {
    const { apply, log } = setup();
    for (let i = 0; i < 21; i++) await apply("203.0.113.7");
    for (let i = 0; i < 30; i++) await log();
  });
});
