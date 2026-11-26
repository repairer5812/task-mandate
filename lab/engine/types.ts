import type { Store } from "@task-mandate/core";
import type { KeyPair } from "../../bench/keys";

export interface Clock {
  ms: number;
}

export interface Queue {
  schedule(at: number, run: () => Promise<void> | void): void;
}

export interface SizedStore extends Store {
  size(): { nonces: number; actions: number; people: number };
}

export interface Site {
  id: string;
  origin: string;
  minSwitchSec: number;
  store?: SizedStore;
  request(input: Request): Promise<Response>;
}

export interface HeldKey {
  pair: KeyPair;
  id: string;
}

export interface SiteKeys {
  principal: HeldKey;
  agents: HeldKey[];
}

export type Intent = { kind: "honest"; boundary?: boolean } | { kind: "replay" } | { kind: "early-switch" } | { kind: "dead-task" } | { kind: "same-tid-agent" } | { kind: "stop-inside" } | { kind: "stop-outside" } | { kind: "shadow" } | { kind: "attack"; name: string; expect?: string };

export interface Task {
  personId: string;
  origin: string;
  site: Site;
  taskId: string;
  principal: HeldKey;
  agent: HeldKey;
  iss: string;
  pa: string;
  maxActions: number;
  tbegSec: number;
  tendSec: number;
  chunkSec: number;
  skew: number;
  mandate?: string;
  window?: { nbf: number; exp: number };
  chunks: { mandate: string; nbf: number; exp: number }[];
  stopped: boolean;
  stoppedExp?: number;
  planned: number;
  retry: "replay" | "drop" | "none";
  replayed: boolean;
  autoSend: boolean;
  boundaryOnRenew: boolean;
  halt(): void;
}
