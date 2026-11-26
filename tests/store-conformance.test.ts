// Acceptance tests for memoryStore against the store contract. Do not edit to make a change pass.
// The Durable Object store runs the same suite in the demo-worker tests.
import { memoryStore } from "@task-mandate/core";
import { defineStoreConformance } from "@task-mandate/store-conformance";

defineStoreConformance("memoryStore", () => memoryStore());
