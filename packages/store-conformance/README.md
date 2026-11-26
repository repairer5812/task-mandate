# @task-mandate/store-conformance

Vitest conformance test suite (`defineStoreConformance`) for `Store` implementations in `task-mandate`. Verifies nonce replay protection, action counter limits and refunds, expiration handling, and person slot rules.

Experimental research implementation (0.1). Not for production.

## Install

```bash
npm i -D @task-mandate/store-conformance @task-mandate/core vitest
```

## Example

```ts
import { memoryStore } from "@task-mandate/core";
import { defineStoreConformance } from "@task-mandate/store-conformance";

defineStoreConformance("memoryStore", () => memoryStore());
```

## License

Apache-2.0
