import { memoryStore } from "@task-mandate/core";
import { type ConformanceNow, defineStoreConformance } from "../src/index.js";

let current = Date.parse("2026-01-01T00:00:00Z");
const now = (() => new Date(current)) as ConformanceNow;
now.advance = (ms) => {
  current += ms;
};

defineStoreConformance("memoryStore fake clock", () => memoryStore({ now }), { now });
