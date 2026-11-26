import type { Store } from "@task-mandate/core";
import { CIVIL_LIMIT, CIVIL_WINDOW_SEC, type CivilLimiter, type CivilLog, createApp, type SeatBook } from "@task-mandate/demo-site";
import { loopbackOriginMismatch, readConfig } from "./config";
import type { Env } from "./env";
import { ROBOTS_TXT } from "./html";
import { tokenMatches } from "./secret";
import { simOptions } from "./sim-config";
import { MandateStore } from "./store";

export { MandateStore };

const ASSET_PATHS = new Set(["/favicon.ico", "/favicon.svg", "/apple-touch-icon.png", "/js/task-mandate.js", "/vendor/three.module.min.js", "/vendor/three.LICENSE", "/vendor/pretendard.LICENSE"]);

function isStaticAsset(pathname: string): boolean {
  return ASSET_PATHS.has(pathname) || pathname.startsWith("/sim/") || pathname.startsWith("/vendor/pretendard/");
}

function siteStub(env: Env): DurableObjectStub<MandateStore> {
  return env.MANDATE_STORE.get(env.MANDATE_STORE.idFromName("site"));
}

function civilLogStub(env: Env): DurableObjectStub<MandateStore> {
  return env.MANDATE_STORE.get(env.MANDATE_STORE.idFromName("civil-log"));
}

function storeFrom(stub: DurableObjectStub<MandateStore>): Store {
  return { claimNonce: (nonce, ttlSec) => stub.claimNonce(nonce, ttlSec), consumeAction: (key, max, ttlSec) => stub.consumeAction(key, max, ttlSec), refundAction: (key) => stub.refundAction(key), claimPersonSlot: (input) => stub.claimPersonSlot(input) };
}

function seatsFrom(stub: DurableObjectStub<MandateStore>): SeatBook {
  return { list: () => stub.listSeats(), take: (facility) => stub.takeSeat(facility), release: (facility) => stub.releaseSeat(facility) };
}

function civilLogFrom(stub: DurableObjectStub<MandateStore>): CivilLog {
  return { append: (entry) => stub.appendCivil(entry), recent: () => stub.recentCivil() };
}

function civilLimiterFrom(stub: DurableObjectStub<MandateStore>): CivilLimiter {
  return { hit: (key, now) => stub.hitCivil(key, now.getTime(), CIVIL_LIMIT, CIVIL_WINDOW_SEC) };
}

async function assetPage(request: Request, env: Env, pathname: string): Promise<Response> {
  const asset = new URL(request.url);
  asset.pathname = pathname;
  asset.search = "";
  const page = await env.ASSETS.fetch(new Request(asset, { method: "GET" }));
  if (request.method !== "HEAD") return page;
  await page.body?.cancel();
  const headers = new Headers(page.headers);
  headers.delete("content-length");
  return new Response(null, { status: page.status, statusText: page.statusText, headers });
}

function stamp(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Robots-Tag", "noindex, nofollow");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function buildApp(env: Env) {
  const config = readConfig(env);
  const stub = siteStub(env);
  const civil = civilLogStub(env);
  const app = createApp({
    origin: config.origin,
    store: storeFrom(stub),
    seatBook: seatsFrom(stub),
    civilLog: civilLogFrom(civil),
    civilLimiter: civilLimiterFrom(civil),
    reserveLimiter: { hit: (key, now) => civil.hitCivil(key, now.getTime(), CIVIL_LIMIT, CIVIL_WINDOW_SEC) },
    sim: simOptions(env, civil),
    personIssuers: config.personIssuers,
    requirePerson: config.requirePerson,
    onePerPerson: config.onePerPerson,
    ...(config.minSwitchSec !== undefined ? { minSwitchSec: config.minSwitchSec } : {}),
    ...(config.maxLifetimeSec !== undefined ? { maxLifetimeSec: config.maxLifetimeSec } : {}),
    ...(config.maxTaskSec !== undefined ? { maxTaskSec: config.maxTaskSec } : {}),
  });
  app.get("/robots.txt", (c) => c.text(ROBOTS_TXT));
  return app;
}

async function reset(request: Request, env: Env): Promise<Response> {
  const secret = env.RESET_TOKEN ?? "";
  const provided = request.headers.get("x-reset-token") ?? "";
  if (secret === "" || !(await tokenMatches(provided, secret))) {
    return Response.json({ error: "forbidden" }, { status: 403 });
  }
  await siteStub(env).reset();
  await civilLogStub(env).reset();
  return Response.json({ ok: true });
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (loopbackOriginMismatch(env.ORIGIN ?? "", url.hostname)) {
      return stamp(new Response("설정 오류", { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } }));
    }
    try {
      if (request.method === "POST" && url.pathname === "/reset") return stamp(await reset(request, env));
      if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/civil") {
        return stamp(await assetPage(request, env, "/civil.html"));
      }
      if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/") {
        return stamp(await assetPage(request, env, "/home.html"));
      }
      if ((request.method === "GET" || request.method === "HEAD") && url.pathname === "/sim") {
        return stamp(await assetPage(request, env, "/sim.html"));
      }
      if (request.method === "GET" && isStaticAsset(url.pathname)) return stamp(await env.ASSETS.fetch(request));
      return stamp(await buildApp(env).fetch(request));
    } catch (error) {
      console.error(error instanceof Error ? error.message : "error");
      return stamp(Response.json({ error: "server-error" }, { status: 500 }));
    }
  },
} satisfies ExportedHandler<Env>;
