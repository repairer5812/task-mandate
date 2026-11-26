import { memoryStore, normalizePublicJwk } from "@task-mandate/core";
import { createApp } from "@task-mandate/demo-site";
import { ed25519, type KeyPair } from "../../bench/keys";
import { IDP_ISS, RESOURCE, SITES } from "../config";
import { held } from "./task";
import type { Clock, Site, SiteKeys } from "./types";

export async function makeIdp(): Promise<KeyPair> {
  return ed25519();
}

export function makeSites(clock: Clock, idp: KeyPair, minSwitchSec: number, remote?: (origin: string) => Site["request"]): Site[] {
  const issuers = [{ iss: IDP_ISS, jwks: [normalizePublicJwk(idp.pub)] }];
  return SITES.map((spec) => {
    if (remote) {
      return { id: spec.id, origin: spec.origin, minSwitchSec, request: remote(spec.origin) };
    }
    const now = () => new Date(clock.ms);
    const store = memoryStore({ now }) as NonNullable<Site["store"]>;
    const app = createApp({
      origin: spec.origin,
      store,
      seats: { [RESOURCE]: 1_000_000 },
      now,
      personIssuers: issuers,
      requirePerson: true,
      onePerPerson: true,
      minSwitchSec,
      // Raise the demo's 1024-byte cap so the lab exercises the verifier's 1 MiB default.
      reserveBodyLimit: 2_097_152,
    });
    return { id: spec.id, origin: spec.origin, minSwitchSec, store, request: (input: Request) => Promise.resolve(app.fetch(input)) };
  });
}

export async function makeSiteKeys(agents: number): Promise<SiteKeys> {
  const principal = await held(await ed25519());
  const list = [];
  for (let i = 0; i < agents; i += 1) list.push(await held(await ed25519()));
  return { principal, agents: list };
}

export async function attackerKeys(): Promise<Map<string, SiteKeys>> {
  const map = new Map<string, SiteKeys>();
  for (const site of SITES) map.set(site.origin, await makeSiteKeys(1));
  return map;
}
