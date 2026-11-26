# @task-mandate/core

Core mandate issuance, verification, person attestation helpers, chunk renewal planning, `Store` interface, and `memoryStore` for `task-mandate`. Pure WebCrypto with no I/O dependencies.

Experimental research implementation (0.1). Not for production.

[Test with an AI agent](https://github.com/repairer5812/task-mandate/tree/main/examples/agent-sandbox) using the public mock API.

## Install

```bash
npm i @task-mandate/core
```

## Example

```ts
import { issueMandate, memoryStore, verifyRequest } from "@task-mandate/core";
import { signRequest } from "@task-mandate/agent";

const mandate = await issueMandate({
  principalKey: principalPrivateJwk,
  agentPublicKey: agentPublicJwk,
  audience: "https://court.example",
  task: { type: "reserve", resource: "court-3" },
  limits: { maxActions: 1 },
  durationSec: 1800,
});

const signed = await signRequest(
  new Request("https://court.example/reserve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ facility: "court-3" }),
  }),
  { mandate, agentKey: agentPrivateJwk },
);

const decision = await verifyRequest(
  signed,
  { origin: "https://court.example" },
  { requireTask: { type: "reserve", resource: "court-3" } },
  memoryStore(),
);

if (decision.decision === "allow" && !(await reserveSeat())) {
  await decision.refund();
}
```

`signRequest` only signs. Agents that send requests use `mandatedFetch`. If the action fails after an allow, `refund()` gives back the consumed action. The check order and reason codes are in [SPEC section 6](https://github.com/repairer5812/task-mandate/blob/main/docs/SPEC.md#6-verification).

## License

Apache-2.0
