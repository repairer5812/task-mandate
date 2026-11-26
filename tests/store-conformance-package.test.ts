// Acceptance tests for the store-conformance package on memoryStore. Do not edit to make a change pass.
import { defineStoreConformance } from "@task-mandate/store-conformance";
import { memoryStore } from "@task-mandate/core";

defineStoreConformance("memoryStore (package)", () => memoryStore(), {
  makePair: () => {
    const shared = memoryStore();
    return [shared, shared];
  },
});
