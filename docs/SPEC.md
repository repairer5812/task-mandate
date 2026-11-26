# Task Mandate Protocol

## 1. Introduction

Task Mandate lets a person delegate one task at one site to one agent key. A mandate can limit when the agent acts and how many actions it takes. The agent signs each request. The site checks the mandate and the request locally, with configured keys and a state store. It does not contact the issuer.

The profile uses SD-JWT VC, RFC 9421 HTTP Message Signatures with the Web Bot Auth tag, and Ed25519. Version 0.1 is experimental and intended for research. Real identity enrollment, payments, general browser automation, and online revocation are outside the scope of this profile. See [DEMO.md](DEMO.md) for the demo applications.

## 2. Terminology

| Term | Meaning |
| --- | --- |
| Principal | The person delegating the task. Their key signs the mandate. |
| Agent | The caller holding the private key named by the mandate. |
| Site | The verifier and application at one HTTP or HTTPS origin. |
| Mandate | A signed credential binding a task, an audience, and an agent key. |
| Task | The work described by a type, an optional resource, and optional parameters. |
| Chunk | One mandate covering a window of a task. Renewals issue new chunks for the same task. |
| Person attestation | A JWT from a configured issuer binding a site-specific subject to a principal key. |
| Store | The state used to track live nonces, action counts, and person slots. |

An origin is the serialized origin of an HTTP or HTTPS URL: scheme, host, and any non-default port, with no path or trailing slash. For example, `https://court.example`. The configured origin and the issued audience must already be in this form. The verifier compares them as strings.

Public key identifiers are unpadded base64url-encoded SHA-256 JWK thumbprints as in RFC 7638. Ed25519 public JWKs use `kty: "OKP"`, `crv: "Ed25519"`, and a valid public key in `x`. Issuers and signers use the corresponding private JWK. Key normalization keeps only `kty`, `crv`, and `x` for a public key.

## 3. Mandate format

Send the compact SD-JWT VC in the `Agent-Mandate` header. For this profile, send the signed issuer JWT followed by `~`. All claims are in the issuer JWT. The verifier checks that JWT and uses its payload directly. It does not process disclosures or an SD-JWT key-binding JWT.

The protected JOSE header MUST contain `typ: "dc+sd-jwt"`, `alg: "EdDSA"`, and the principal's public `jwk`. The site verifies the JWT with this key. The `iss` value MUST match the thumbprint of the same key.

| Claim | Type | Required | Meaning |
| --- | --- | --- | --- |
| `vct` | String | Yes | Exactly `urn:task-mandate:v0`. |
| `iss` | Non-empty string | Yes | `urn:jwk-thumbprint:sha-256:` followed by the principal key thumbprint. |
| `sub` | Non-empty string | Yes | Equal to `iss` without `pa`. Equal to the attested subject when `pa` is present. |
| `aud` | Non-empty string | Yes | The site origin. The verifier requires an exact match to its configured origin. |
| `cnf` | Object | Yes | Contains `jwk`, the agent's public Ed25519 JWK. |
| `task` | Object | Yes | Contains non-empty string `type`, optional string `resource`, and optional object `params`. An empty string is allowed for `resource`. An array or null fails the object check. The application interprets `params`. |
| `limits` | Object | No | Contains integer `maxActions`, 1 or greater. |
| `iat` | Integer | Yes | Issue time in Unix seconds. |
| `nbf` | Integer | Yes | Chunk start in Unix seconds. |
| `exp` | Integer | Yes | Chunk expiry in Unix seconds. |
| `jti` | Non-empty string | Yes | Chunk identifier. The issuer helper encodes 16 random bytes as base64url. |
| `tid` | Non-empty string | No | Stable task identifier across chunks. The verifier uses `jti` when this is absent. |
| `tbeg` | Integer | Conditional | Task start in Unix seconds. Required when `onePerPerson` is enabled and `tid` is present. The verifier otherwise uses `iat` as the task start when `tbeg` is absent. |
| `tend` | Integer | No | Task end in Unix seconds. The verifier uses `exp` when this is absent. |
| `pa` | String | Conditional | Compact person-attestation JWT. Required when the site enables `requirePerson`. |

The verifier enforces these size limits before checking the mandate signature.

| Value | Maximum |
| --- | --- |
| `Agent-Mandate` header value | 8192 UTF-8 bytes |
| `pa` | 4096 UTF-8 bytes |
| `iss`, `sub` | 256 UTF-16 code units each |
| `jti`, `tid` | 128 UTF-16 code units each |

The timestamps MUST satisfy `iat <= exp` and `nbf <= exp`. If present, `tend` MUST satisfy `exp <= tend` and `tbeg` MUST satisfy `tbeg <= nbf`. There is no ordering check between `iat` and `nbf`. A value exactly at a size limit passes the size check.

`issueMandate` takes `principalKey`, `agentPublicKey`, `audience`, `task`, and `durationSec`. The duration is an integer from 1 through 2592000. `now` defaults to the current time. `notBefore` defaults to the issue time. Explicit `notBefore`, `taskBegin`, and `taskEnd` values must be valid dates. The helper floors date timestamps to Unix seconds and calculates `exp = nbf + durationSec`. Optional `taskId`, `taskBegin`, and `taskEnd` set `tid`, `tbeg`, and `tend`. An explicit `taskEnd` earlier than `exp` fails issuance. The site applies the wire checks independently of the helper.

## 4. Person attestation

The attestation is a compact JWT. Its protected header MUST contain `typ: "person-attestation+jwt"`, `alg: "EdDSA"`, and `kid` equal to the attestation issuer key thumbprint. The verifier obtains the key from its configured issuer list. It ignores embedded keys, key URLs, and certificate chains.

| Claim | Type | Meaning |
| --- | --- | --- |
| `iss` | Non-empty string | Attestation issuer identifier. |
| `sub` | Non-empty string | Pairwise subject for this issuer and audience. |
| `aud` | String | The site origin. It must match the site's configured origin exactly. |
| `cnf` | Object | Contains `jwk`, the principal's public Ed25519 JWK. |
| `iat` | Integer | Issue time in Unix seconds. |
| `exp` | Integer | Expiry in Unix seconds. |

The bundled issuer helper computes `sub` as unpadded base64url of HMAC-SHA-256. The key is the UTF-8 encoding of the issuer secret string. The message is the UTF-8 encoding of `personId + "\u0000" + audience`, with a literal NUL separator. The verifier uses the signed subject string without recomputing it.

`issuePersonAttestation` takes `idpKey`, `idpIssuer`, `secret`, `personId`, `audience`, `principalPublicKey`, and `durationSec`. The audience must be a serialized origin. The duration must be finite and at least 0. The helper sets `iat` from `now` or the current time, and sets `exp` to `iat + floor(durationSec)`.

When `personAttestation` is supplied to `issueMandate`, the helper trims it, reads `sub` and `exp` without verifying the signature, and includes it as `pa`. Issuance fails if the attestation expiry is earlier than the chunk expiry. The site independently checks the attestation at request time.

Configure `personIssuers` as an array of `{ iss, jwks }` entries. The verifier combines the key lists for entries with the same `iss`. It uses the first usable key whose thumbprint matches `kid`. Multiple keys under one issuer identifier allow key rotation.

For any supplied attestation, the verifier MUST check the format, configured issuer and key, signature, audience, times, and mandate binding. The attestation MUST satisfy `iat <= exp`, and its `exp` MUST NOT be earlier than the mandate's `exp`. The time check passes at `iat - clockSkewSec` and at `exp + clockSkewSec`. The mandate's `iss` must be the thumbprint URI derived from the attestation's `cnf.jwk`. The mandate's `sub` must equal the attestation's `sub`.

## 5. Request signing

Sign with the agent's Ed25519 private key and send matching RFC 9421 `Signature-Input` and `Signature` fields. The verifier accepts one signature input. It checks the signature against the public key in the mandate's `cnf.jwk`.

The signature MUST cover these components without component parameters.

| Applies to | Required components |
| --- | --- |
| Every request | `@method`, `@authority`, `@path`, `@query`, `agent-mandate` |
| Request with a body | All of the above and `content-digest` |

A request has a body when its Fetch `Request.body` is non-null. This includes a stream with zero bytes. The `Content-Digest` field MUST equal `sha-256=:<digest>:`, where `<digest>` is the standard base64 encoding of the SHA-256 digest of the body bytes. The verifier compares this exact field value. It requires neither a digest field nor a digest check for a request with a null body.

| Signature parameter | Value |
| --- | --- |
| `tag` | `web-bot-auth` |
| `keyid` | Agent key thumbprint |
| `created`, `expires` | Unix seconds. `created <= expires` and `expires - created <= 300`. The signer sets `expires = created + 300`. |
| `nonce` | Canonical standard base64 or unpadded base64url encoding of 64 bytes. The signer generates 64 random bytes and uses standard base64. Generate a fresh nonce per request. |
| `alg` | The signer emits `ed25519`. Verification uses the Ed25519 key from the mandate. |

The verifier delegates signature parsing, signature age and expiry checks, and nonce syntax to `web-bot-auth`. It supplies the verifier time, a maximum age of 300 seconds, and `clockSkewSec`. It also checks the tag, the required components, and the 300-second window.

## 6. Verification

`verifyRequest(request, config, route, store, now?)` returns a promise for a decision. Mandate, attestation, and nonce TTL calculations use `nowSec = floor(now.getTime() / 1000)`. `now` defaults to the current time. Store operations use the clocks in Section 8.

### Configuration

| Setting | Default | Type and rule |
| --- | --- | --- |
| `origin` | Required | Serialized HTTP or HTTPS origin. |
| `maxLifetimeSec` | 86400 | Integer from 1 through 2592000. Caps `exp - nbf`. |
| `clockSkewSec` | 30 | Integer from 0 through 300. |
| `maxTaskSec` | 2592000 | Integer from 1 through 2592000. Caps `(tend ?? exp) - (tbeg ?? iat)`. |
| `maxBodyBytes` | 1048576 | Integer of at least 1. No explicit upper bound. |
| `trustedIssuers` | Empty array | List of accepted mandate issuer strings. An empty list allows any valid self-issued mandate at this check. |
| `onNoMandate` | `"challenge"` | `"challenge"` or `"deny"`. |
| `personIssuers` | Empty array | List of trusted person-attestation issuer identifiers and JWKs. |
| `requirePerson` | `false` | Boolean. If true, the `personIssuers` list must be non-empty. |
| `onePerPerson` | `false` | Boolean. If true, `requirePerson` must be true and there must be only one distinct person issuer identifier. |
| `minSwitchSec` | 600 | Finite number of at least 1. Fractional values are accepted. No explicit upper bound. |

The verifier validates configuration before inspecting the request. The configuration checks enforce the numeric bounds, origin serialization, and person issuer dependencies above. The route policy can specify `requireTask: { type, resource? }`.

### Check order

Run the checks in this order. The first failure sets the reason code. All failures give `deny` except for `NO_MANDATE`, which uses `onNoMandate`.

| Order | Failure condition | Reason code |
| --- | --- | --- |
| 1 | The `Agent-Mandate` header is absent. An empty value proceeds to mandate parsing. | `NO_MANDATE` |
| 2 | A declared `Content-Length` exceeds `maxBodyBytes`, or the value is invalid. | `BODY_TOO_LARGE` |
| 3 | Mandate parsing, size, header `typ`, claim shape, claim values, or time ordering fails. This includes invalid agent JWKs and missing `tbeg` when required. | `MANDATE_MALFORMED` |
| 4 | The mandate's principal JWK is missing or invalid, its thumbprint URI differs from `iss`, `alg` differs from `EdDSA`, or the mandate signature is invalid. | `MANDATE_SIG_INVALID` |
| 5 | `trustedIssuers` is non-empty and lacks the mandate's `iss`. | `ISSUER_NOT_TRUSTED` |
| 6 | `requirePerson` is true and `pa` is absent. | `PERSON_REQUIRED` |
| 7 | A supplied `pa` fails any check in Section 4. | `PERSON_INVALID` |
| 8 | Either the mandate's `aud` or the request URL's serialized origin differs from `config.origin`. | `AUD_MISMATCH` |
| 9 | `nowSec < nbf - clockSkewSec` or `iat > nowSec + clockSkewSec`. | `NOT_YET_VALID` |
| 10 | `nowSec >= exp + clockSkewSec` or `nowSec >= (tend ?? exp) + clockSkewSec`. | `EXPIRED` |
| 11 | `exp - nbf > maxLifetimeSec` or `(tend ?? exp) - (tbeg ?? iat) > maxTaskSec`. | `LIFETIME_TOO_LONG` |
| 12 | Both `Signature` and `Signature-Input` are absent. | `SIG_MISSING` |
| 13 | Only one signature field is present, or the signature input cannot supply a key ID from one structured-field member. | `SIG_INVALID` |
| 14 | The supplied `keyid` differs from the mandate's agent key thumbprint. | `KEY_MISMATCH` |
| 15 | HTTP message signature verification fails, the tag is wrong, or a required bare component is missing. | `SIG_INVALID` |
| 16 | The streamed body exceeds `maxBodyBytes`. | `BODY_TOO_LARGE` |
| 17 | The digest check fails, the signature window is non-finite or exceeds 300 seconds, or the nonce is invalid. | `SIG_INVALID` |
| 18 | The store returns `false` when claiming the nonce. | `REPLAY` |
| 19 | `requireTask` is set and `task.type` differs, or `requireTask.resource` is set and `task.resource` differs. | `TASK_NOT_ALLOWED` |
| 20 | The action count applies and its TTL is less than 1 second. | `EXPIRED` |
| 21 | The action count applies and `consumeAction` returns `false`. | `LIMIT_EXCEEDED` |
| 22 | The person slot applies and `claimPersonSlot` returns `"superseded"`. Refund any action counted in step 21. | `SUPERSEDED` |

The early body check accepts a `Content-Length` value of decimal digits, after trimming, that represents a non-negative safe integer. Other values are treated as over the cap. The verifier checks actual body bytes even with a declared length at or below the cap. It reads a clone and stops when a chunk would exceed the cap. That chunk is discarded. The request body remains available to the application.

The nonce claim uses the signature's nonce string as its key. Its TTL is `max(floor(signatureExpiresMs / 1000) - nowSec + clockSkewSec, 1)` seconds. A nonce is reserved before task matching, action counting, or a person-slot claim. A later denial or refund leaves that nonce reserved until expiry.

### Decision and refunds

A non-allow decision is `{ decision: "challenge" | "deny", code: ReasonCode }`. An allow decision has `decision: "allow"` and these fields.

| Field | Value |
| --- | --- |
| `principal` | Mandate `sub`. |
| `agentKeyId` | Thumbprint of the mandate's `cnf.jwk`. |
| `mandateId` | Mandate `jti`. |
| `taskId` | Mandate `tid`, or `jti` if absent. |
| `task` | The checked task object. |
| `person` | Present after successful attestation verification. Contains the attestation's `iss` and `sub`. Use this pair to identify the attested subject. |
| `refund()` | Asynchronous callback to undo one consumed action. |

Call `refund()` when verification consumed an action but the action did not happen. It decrements at most once per allow decision and does nothing if no action was consumed. A second call does not retry a failed refund. The nonce and the person slot stay in place.

The `@task-mandate/hono` middleware `taskMandate` requires a store and accepts an optional `now: () => Date`. Each protected route can supply a route policy. It exposes the allow decision as `c.get("mandate")`. It returns a non-allow decision as JSON with status 401 for `challenge` and 403 for `deny`. It refunds the action if the downstream response is outside 200 through 299 or if the downstream handler throws. It rethrows a handler exception after the refund succeeds.

## 7. Action counting and one-per-person

### Action counter

The counter applies when the route specifies `requireTask` and the mandate includes `limits`. Its key is `iss + "\u0000" + aud + "\u0000" + (tid ?? jti)`, using literal NUL separators. Set a common `tid` and `tend` across chunks to carry the count to the end of a task.

The TTL passed to the store is `(tend ?? exp) + clockSkewSec - nowSec` seconds. A row is expired at `expiresAt <= now` on the store clock. Call `consumeAction` once to check the count against the supplied `maxActions` and increment it atomically. A failed consume can extend a live counter's expiry. It does not increase the count. A refund decrements a live positive count and leaves its expiry in place while the count remains positive.

### Person slot

With `onePerPerson` enabled, every request that reaches the slot check must claim the slot. This includes routes without `requireTask`. The claim uses the following fields.

| Field | Value |
| --- | --- |
| `personKey` | Attestation `iss + "\u0000" + sub`, with a literal NUL separator. |
| `taskKey` | The action counter key, even when the route does not count actions. |
| `agentKeyId` | Agent key thumbprint. |
| `taskBegin` | `tbeg ?? iat`, in Unix seconds. |
| `expiresAt` | `(tend ?? exp) + clockSkewSec`, in Unix seconds. |
| `now` | `nowSec`, in Unix seconds. |
| `minSwitchSec` | The configured minimum interval, in seconds. |

The store keeps one current slot and a list of displaced task and agent pairs for each person key. The current slot records the pair, `taskBegin`, `claimedAt`, and `expiresAt`. Each displaced pair retains its own expiry. Discard expired entries at `expiresAt <= now` before applying the first matching rule.

| Order | Condition | Result and change |
| --- | --- | --- |
| 1 | The incoming `(taskKey, agentKeyId)` matches a live displaced pair. | `"superseded"`. |
| 2 | There is no live current slot. | `"ok"`. Open a slot with the incoming values and `claimedAt = now`. |
| 3 | The incoming pair and `taskBegin` match the current slot. | `"ok"`. Set expiry to the later of the current and incoming expiries. Keep `claimedAt`. |
| 4 | The incoming pair differs, its `taskBegin` is strictly later, and `now - claimedAt >= minSwitchSec`. | `"ok"`. Move the current pair to the displaced list with its current expiry. Open the incoming slot with `claimedAt = now` and the later of the two expiries. |
| 5 | All other claims. | `"superseded"`. |

Two tasks with equal start times cannot displace each other while the current slot is live. Changing the start time alone cannot switch a live slot. Changing the agent key changes the pair.

Action counting MUST run before slot admission. An exhausted counter leaves the slot untouched. A rejected slot triggers a refund of any action consumed for the request. A successful slot claim stays in place even if the application later fails or refunds the action.

## 8. Store interface

| Method | Atomic behavior |
| --- | --- |
| `claimNonce(nonce, ttlSec): Promise<boolean>` | Return `false` for a live nonce. Otherwise record the nonce for the TTL and return `true`. |
| `consumeAction(key, max, ttlSec): Promise<boolean>` | Return `false` without consuming if `ttlSec < 1`. Treat an expired row as absent. Return `true` and increment once if the live count is below `max`. For a valid TTL, expiry is the later of the live expiry and the candidate expiry from the TTL. A call at the limit can extend a live expiry. |
| `refundAction(key): Promise<void>` | Decrement a live positive count once. An absent, expired, or zero count is unaffected. The supplied stores delete the row at zero. |
| `claimPersonSlot(input): Promise<"ok" \| "superseded">` | Prune this person's expired entries and apply the slot rules as one operation. The input fields are listed in Section 7. |

Each method MUST be atomic for competing callers, including callers through separate store handles. Use a shared store namespace across all verifier instances for the same site. The backend must support atomic updates or provide a way to serialize the corresponding reads and writes.

Nonce and action TTLs use the store clock and are passed in seconds. The supplied stores record nonce expiry at store time in milliseconds plus `ttlSec * 1000`. They calculate action expiry from the store time floored to whole seconds plus `ttlSec`. In both cases equality is expired. Person-slot claims use the verifier clock passed in `input.now`. Keep the verifier and store clocks aligned, including when pruning person state outside a claim.

`memoryStore({ now? })` is process-local. Its optional clock controls nonce and action expiration and the cleanup done by `size()`. The default clock is the current time. `size()` returns counts as `{ nonces, actions, people }`. The supplied memory and Worker stores hash nonce, action, person, and slot task keys with SHA-256 and store the hash as hexadecimal.

`@task-mandate/store-conformance` exports `defineStoreConformance(name, makeStore, options?)` for Vitest. The factory returns a fresh store for each case. The suite checks replay, TTL boundaries, counting, refunds, slot rules, and concurrent calls. `options.now` provides a test clock. Its optional `advance(ms)` moves the clock instead of sleeping. `options.makePair` adds shared-state tests for concurrent action counts and nonce claims through two handles to the same store.

## 9. Renewal and revocation

A `LeasePlan` contains `taskId`, `start`, `end`, and `chunkSec`. For successive chunks, issue a new `jti` and reuse the task ID, task start, task end, audience, and keys. Supply `taskId`, `taskBegin: plan.start`, and `taskEnd: plan.end` to `issueMandate`. A long task may need a fresh person attestation for later chunks.

`nextRenewal(plan, now, current, stopped)` requires a finite `chunkSec` of at least 1 and valid dates, with `end > start`. `current`, when present, contains `nbf` and `exp`. After checking the inputs, apply the first matching rule.

| Condition | Result |
| --- | --- |
| `stopped` is true | `stopped` |
| `now >= end` | `finished` |
| `now < start` | `not-started` |
| There is no current chunk, or its remaining time in seconds is at most `chunkSec / 2`. | Issue with `nbf = now` and `exp = min(now + chunkSec, end)`, adding the duration in seconds. |
| Otherwise | `waiting` |

`Renewer` serializes calls to `tick()`. It takes a plan, `issue({ nbf, exp })` and `write(mandate)` callbacks, an optional clock, and an optional initial chunk. On successful issuance and write, it returns `issued` and makes the token available through `current()`. `stop()` prevents later issuance. It discards an issue result if stopped before the write starts. A write already in progress may complete. The caller supplies the schedule and must issue tokens within the windows returned by the plan for the expiry bound to hold.

Stopping renewal leaves the last issued chunk usable until the site's expiry check fails. On a common clock, the maximum time from stopping renewal to that boundary is `chunkSec + clockSkewSec`. For the CLI's default 600-second chunk and the verifier's default 30-second skew, the bound is 630 seconds. It applies to new verification decisions. It does not terminate work already admitted. There is no online mandate or person-attestation revocation check.

The `tm` CLI in `@task-mandate/cli` supports `keygen`, `issue`, `inspect`, `delegate`, `run`, `list`, `stop`, and mock issuer commands under `idp`. `keygen` writes a private JWK and a sibling `.pub.json` file. `inspect` reports whether the mandate shape and signature pass and displays the remaining time.

`delegate` issues the first chunk and stores task state under `TM_HOME`, which defaults to `~/.task-mandate`. `run` checks renewal every 30 seconds by default and rereads the attestation file on each issuance if configured. The output file is replaced by rename before the state record is updated. `stop` writes a stop marker, waits for the task lock, and reads the output mandate's expiry for display. The displayed time is the raw `exp` in ISO 8601, without verifier skew.

## 10. Agent behavior

`mandatedFetch` and `signRequest` are exported by `@task-mandate/agent`. Both accept a mandate string or a function that returns it, synchronously or asynchronously. They read the source once per call, trim the result, and reject missing or blank values.

`mandatedFetch(input, init, options)` takes a string or URL. Before sending, it checks the mandate's shape and issuer signature, and compares `aud` with the request URL's origin. It refuses to send when `floor(nowMs / 1000) >= exp + 30`, the same boundary a verifier with the default skew uses. The agent check has no site trust, attestation, route, start time, or state policy. The request uses `redirect: "manual"`.

`signRequest(request, options)` signs without verifying the mandate claims, audience, expiry, or key binding. It replaces the mandate header and computes a new digest if a body is present. It rejects a body above 2097152 bytes by default. It stops reading when a chunk would exceed the cap. The optional `maxBodyBytes` changes the signing cap. `mandatedFetch` uses the default signing cap.

## 11. Error model

`TaskMandateError` extends `Error` and exposes `code` and an English message. The codes below describe caller errors. Verification failures return a decision with one of the reason codes in Section 6.

| Code | Meaning |
| --- | --- |
| `CONFIG_INVALID` | Invalid verifier or middleware configuration. |
| `INPUT_INVALID` | Invalid caller input detected by issuance, renewal, or agent checks. |
| `KEY_INVALID` | A JWK fails the library's Ed25519 key shape checks. |
| `STORE_REQUIRED` | Hono middleware was configured without a store. |

Underlying operations can reject with their own errors. This includes the store, I/O, WebCrypto key imports, Fetch, and caller-supplied callbacks. Callers must handle a rejected promise separately from a verification decision.

## 12. Security considerations

- A mandate signature establishes control of the principal key. An HTTP message signature establishes control of the named agent key. A valid signature alone gives the site no real-world identity. A site can use `trustedIssuers` to pin known principal keys, or `requirePerson` to require a binding from an attestation issuer.
- An attestation issuer can bind any subject it controls to any principal key. This includes an existing subject whose slot can then be displaced under the slot rules. The security of the binding depends on the issuer's identity checks and key handling.
- The request signature protects the required components and the digest of body bytes. Other headers are protected only if covered. Use HTTPS to protect credentials and content in transit.
- Replay protection rejects a second claim of the same live nonce in the same store. Action limits apply to counted routes and to the counter key. The site must define and enforce its own route and application policy, including the meaning of task parameters.
- The counter uses the limit and task end in each presented mandate. The verifier does not enforce consistent limits across chunks or a total quota across tasks, keys, or sites. The person slot limits concurrent task and agent pairs per attested subject. It does not stop requests already admitted.
- Nonce claims, action consumption, slot claims, and application actions are separate operations. A refund compensates only the action counter. An exception or process failure between operations can leave state recorded. The refund is keyed to the live counter, with no per-action receipt or protection against a counter being recreated before a delayed refund.
- The protocol does not provide key recovery, immediate revocation, or protection from a principal or agent private key compromise. It has no online status check or transparency log.
- The header and body limits bound some per-request work. Aggregate rate limits, admission control, and store capacity planning are deployment concerns. The implementation has no independent security audit.

## 13. Privacy considerations

The attestation subject varies by issuer secret, person identifier, and site origin. It remains stable for the same inputs. The issuer knows the origin and the person identifier used to compute it. Changing the issuer secret changes subjects, which can also change how a site recognizes an existing person slot.

The site sees the mandate claims, the principal key thumbprint in `iss`, and the agent key thumbprint in `keyid`. Reusing either key across sites permits correlation by thumbprint. Use separate principal and agent keys for each site when relying on pairwise subjects. The mandate carries its claims in cleartext within the signed token.

## 14. Conformance

The JSON fixtures in [vectors/](../vectors/) include an allow case and cases covering every reason code. Each fixture gives verifier configuration, a verification time, a route policy, and ordered request and expectation pairs. The test uses a fresh store for each fixture and shares it across that fixture's steps. The expected results cover the serializable decision fields. `vectors/keys.json` contains public test material and fixed private keys for tests only.

Run from the repository root with Node.js 22 or later and pnpm.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm test:worker
```

`pnpm test` includes the vector and memory store tests. `pnpm test:worker` runs the Worker tests, including the Durable Object store cases. `pnpm build && pnpm vectors` regenerates the fixtures using the script in `scripts/gen-vectors.ts` and writes them to `vectors/`.
