# Changelog

## 0.1.0

First release. Experimental.

- Mandates: SD-JWT VCs signed by the principal key, naming one agent key, one website, one task, an expiry, and an optional action limit.
- `verifyRequest` with a fixed check order and reason codes. See [SPEC section 6](docs/SPEC.md#6-verification).
- Action counts that carry across renewed chunks of one task, and `refund()` on an allow decision.
- Person attestations from configured issuers, and an optional one-task-per-person slot.
- `mandatedFetch` and `signRequest` for agents, and the `Renewer` for long tasks.
- `@task-mandate/hono` middleware.
- `tm` CLI for keys, issuing, inspecting, and renewing delegations.
- `@task-mandate/store-conformance` Vitest suite for custom stores.
