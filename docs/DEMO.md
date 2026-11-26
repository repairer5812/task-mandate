# Demo applications

The demos use the Task Mandate verifier for test reservations and mock civil-service applications. They do not book real facilities or file real applications.

Use the [public API quickstart](../examples/agent-sandbox/README.md) to test with an AI agent or a Node.js client.

## Reservation site

`GET /slots` lists facilities and remaining seats. `POST /reserve` accepts a JSON body such as `{"facility":"court-3"}`. The route requires a mandate of type `reserve` whose resource equals the facility in the body. That match is checked before an action is counted or a person slot is claimed. An unknown or full facility is found after verification: the action is refunded, and the slot claim stays. It returns 404 for an unknown facility, 409 for a full facility, or 200 with the remaining seat count on success.

## Mock civil-service counter

`GET /civil/services` lists `basic-pension`, `resident-copy`, and `disability-taxi`. `POST /civil/apply` accepts a JSON body such as `{"service":"basic-pension"}`. It requires task type `apply` and checks a supplied service name against the mandate resource before counting an action. A service name can contain at most 64 UTF-16 code units. A successful reply includes a receipt number with prefix `MO-` and eight uppercase letters or digits.

The Worker serves the counter page at `/civil`. It polls the public `/civil/log` feed every 2 seconds in live mode. The feed retains up to 50 recent outcomes with time, status, reason, service, and a short task label. Requests rejected by the rate limiter are excluded. The log schema has no fields for raw mandates, signatures, keys, person identifiers, or IP addresses. The service and task label can contain caller-supplied text.

## Voice delegation simulation

`/sim` accepts Korean speech through browser speech recognition. Typed text and example buttons are also available. `POST /sim/interpret` accepts non-empty text up to 200 UTF-16 code units. It can send the text to the FactChat LLM API when `FACTCHAT_API_KEY` is set. It uses keyword rules if the model is unavailable, fails, or reaches its quota. Model results are restricted to known service IDs, durations from 60 through 86400 seconds, and action limits from 1 through 3.

After the user confirms the task, the browser creates principal and agent keys and sends the principal public key to `POST /sim/attest`. With a mock issuer configured, the endpoint issues a 600-second attestation for a new random mock person identifier. The browser keeps the private keys, issues a mandate capped by the remaining attestation lifetime, and sends a signed request to `/civil/apply`. The simulator shows the response in a 3D scene or a 2D view for reduced motion and browsers without working WebGL.

The mock issuer accepts eligible requests without checking real identity. A repeat visitor can receive a new subject, so the person slot does not impose a one-task limit per real visitor.

## Cloudflare Worker

`apps/demo-worker` serves the pages and uses the same Hono routes as `apps/demo-site`. A SQLite-backed Durable Object named `site` stores verification state and seats. The `civil-log` object stores the public log and request quotas. Seat restoration is scheduled after the first successful reservation since the last restoration. `SEAT_RESET_SEC` defaults to 3600 seconds.

Use `pnpm --filter @task-mandate/demo-worker dev` for local development and `pnpm deploy:worker` to deploy. The tracked configuration enables `REQUIRE_PERSON` and `ONE_PER_PERSON`, with a task cap of 86400 seconds. Supply the trusted public issuer keys in `PERSON_ISSUERS`. The tracked empty list is a placeholder and fails verifier configuration for the app routes. Set `SIM_IDP_JWK` as a Worker secret to enable mock attestation. Its issuer and public key must match the configured trust for an attestation to pass. `FACTCHAT_API_KEY` enables model interpretation, and `SIM_PRESENTER_CODE` configures the presenter quota. `POST /reset` clears state in both objects and requires a matching `x-reset-token` and configured `RESET_TOKEN`.

## Public-demo protections

| Endpoint or feature | Limit |
| --- | --- |
| `POST /reserve`, `POST /civil/apply` | 20 requests per client IP per 60-second fixed window, separately for each route on the Worker. |
| `POST /sim/attest` | 10 requests per client IP per 600-second fixed window. |
| Bodies on `/reserve`, `/civil/apply`, `/sim/attest`, and `/sim/interpret` | 1024 bytes by default. The rate limits on reserve, apply, and attest run before the body check. |
| Model interpretation | 3 calls per client IP per 600-second fixed window and 30 calls across ordinary users per day in UTC+09:00. |
| Presenter model interpretation | A matching `x-presenter-code` skips the per-IP model quota. A separate daily quota of 100 calls still applies. |

The body cap returns 413. The reservation, application, and attestation rate limits return 429. Model quotas fall back to keyword interpretation. The Worker keys its IP limits from `cf-connecting-ip` and uses a shared fallback bucket when the header is absent. It stores hashes of the rate-limit keys. These quotas count by IP, so users behind one address share a quota and users on different addresses can use separate quotas.

The Worker sets `X-Robots-Tag: noindex, nofollow` and serves a `robots.txt` that requests no crawling. These directives depend on crawler compliance. The demo pages and public feeds remain accessible by URL.
