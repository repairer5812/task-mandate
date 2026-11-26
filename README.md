# task-mandate

A person gives one AI agent permission to do one task on one website, for a limited time and a limited number of actions. The website checks that permission on its own, without calling anyone.

task-mandate is built from existing standards: SD-JWT VC for the mandate, RFC 9421 HTTP Message Signatures with the IETF Web Bot Auth tag for each request, and Ed25519 keys. It is a profile of these standards: it adds one header and a few claims, listed in the spec.

Status: experimental research code, version 0.1. Not for production use. The code has had automated review only.

- Specification: [docs/SPEC.md](docs/SPEC.md) ([Korean](docs/SPEC.ko.md))
- Demo: https://task-mandate-demo.repairer5812.workers.dev/sim (voice delegation to a mock civil-service counter; nothing real is filed)
- Korean README: [README.ko.md](README.ko.md)

## How it works

1. The person signs a mandate with their own key. It names the agent's public key, the website, the task, an expiry, and optionally a maximum number of actions.
2. The agent sends the mandate in an `Agent-Mandate` header and signs every request with its own key.
3. The website verifies both signatures, the expiry, the task, and the action count. It then allows the request or returns a reason code.

Long tasks use short mandates that are renewed. After renewal stops, the last mandate stays usable for at most one chunk plus the verifier's clock skew (630 seconds with the CLI's 600-second chunk and the default 30-second skew). A website can also require a person attestation from an issuer it trusts, and limit each person to one active task.

## Install

```bash
npm i @task-mandate/core @task-mandate/agent
npm i @task-mandate/hono   # for Hono servers
```

## Quick start

The four blocks below run as one file.

### 1. Issue a mandate

```ts
import { issueMandate } from "@task-mandate/core";

async function newKeyPair() {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  return { priv: await crypto.subtle.exportKey("jwk", kp.privateKey), pub: await crypto.subtle.exportKey("jwk", kp.publicKey) };
}

const principal = await newKeyPair();
const agent = await newKeyPair();

const mandate = await issueMandate({
  principalKey: principal.priv,
  agentPublicKey: agent.pub,
  audience: "https://court.example",
  task: { type: "reserve", resource: "court-3" },
  limits: { maxActions: 1 },
  durationSec: 1800,
});
```

### 2. Sign a request as the agent

```ts
import { signRequest } from "@task-mandate/agent";

const reserve = () =>
  new Request("https://court.example/reserve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ facility: "court-3" }),
  });

const signed = await signRequest(reserve(), { mandate, agentKey: agent.priv });
```

Against a real server, use `mandatedFetch(url, init, { mandate, agentKey })`. It checks the mandate signature, the audience, and the expiry before it signs and sends. `signRequest` only signs.

### 3. Verify on the website

```ts
import { memoryStore, verifyRequest } from "@task-mandate/core";

const decision = await verifyRequest(
  signed,
  { origin: "https://court.example" },
  { requireTask: { type: "reserve", resource: "court-3" } },
  memoryStore(),
);
if (decision.decision !== "allow") throw new Error(decision.code);
```

If the action then fails, call `decision.refund()` to give the action back.

### 4. Or use the Hono middleware

```ts
import { Hono } from "hono";
import { type MandateEnv, taskMandate } from "@task-mandate/hono";

const guard = taskMandate({ origin: "https://court.example", store: memoryStore() });
const app = new Hono<MandateEnv>();
app.post("/reserve", guard({ requireTask: { type: "reserve", resource: "court-3" } }), (c) =>
  c.json({ ok: true, principal: c.get("mandate").principal }),
);

const first = await app.request(await signRequest(reserve(), { mandate, agentKey: agent.priv }));
const second = await app.request(await signRequest(reserve(), { mandate, agentKey: agent.priv }));
console.log(first.status, second.status); // 200 403 (LIMIT_EXCEEDED)
```

The middleware returns 401 for a challenge (`NO_MANDATE` by default) and 403 for a deny. It refunds the action when the handler returns a non-2xx status or throws.

## Packages

| Package | Contents |
| --- | --- |
| `@task-mandate/core` | Issuing and verifying mandates, person attestations, renewal planning, the `Store` interface, and `memoryStore`. WebCrypto only, no I/O. |
| `@task-mandate/agent` | `signRequest`, `mandatedFetch`, and the `Renewer`. Runs in browsers, Cloudflare Workers, and Node.js. |
| `@task-mandate/hono` | The `taskMandate` middleware. `hono` is a peer dependency. |
| `@task-mandate/cli` | The `tm` command: keys, issuing, inspecting, and renewing delegations. |
| `@task-mandate/store-conformance` | A Vitest suite for checking your own `Store` implementation. |

## Reason codes

A failed check returns one code. `NO_MANDATE` returns `challenge` by default. Every other code returns `deny`. [SPEC section 6](docs/SPEC.md#6-verification) gives the exact conditions and their order.

| Code | Meaning |
| --- | --- |
| `NO_MANDATE` | No `Agent-Mandate` header. |
| `BODY_TOO_LARGE` | The body is larger than `maxBodyBytes`. |
| `MANDATE_MALFORMED` | The mandate cannot be parsed or its claims are invalid. |
| `MANDATE_SIG_INVALID` | The mandate signature does not verify. |
| `ISSUER_NOT_TRUSTED` | The principal is not in `trustedIssuers`. |
| `PERSON_REQUIRED`, `PERSON_INVALID` | The person attestation is missing or does not verify. |
| `AUD_MISMATCH` | The mandate or the request is for a different website. |
| `NOT_YET_VALID`, `EXPIRED`, `LIFETIME_TOO_LONG` | The time window is wrong. |
| `SIG_MISSING`, `SIG_INVALID`, `KEY_MISMATCH` | The request signature is absent, invalid, or from another key. |
| `REPLAY` | The signature nonce was already used. |
| `TASK_NOT_ALLOWED` | The task does not match the route. |
| `LIMIT_EXCEEDED` | No actions are left. |
| `SUPERSEDED` | Another live task holds this person's slot (see [SPEC section 7](docs/SPEC.md#7-action-counting-and-one-per-person)). |

## Before you deploy

- Action limits and task checks apply only on routes that set `requireTask`. A route without it accepts any task and does not count actions.
- `trustedIssuers` is empty by default. A valid mandate from any key is then accepted. This proves only that the request came from the agent the mandate names. To tie a mandate to known people, set `trustedIssuers` or `requirePerson`.
- `memoryStore()` lives in one process. Run more than one instance only with a shared `Store` that passes `@task-mandate/store-conformance`.
- Websites see the principal and agent key thumbprints. Use separate keys for each website if requests should not be linkable across websites.
- There is no online revocation. A stopped delegation stays usable until its current mandate expires.

Report vulnerabilities as described in [SECURITY.md](SECURITY.md). To contribute, see [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[Apache-2.0](LICENSE). Third-party notices for the demo are in [NOTICE](NOTICE).
