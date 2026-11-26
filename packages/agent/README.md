# @task-mandate/agent

Agent-side HTTP message signing (`signRequest`, `mandatedFetch`) and chunk renewal runner (`Renewer`) for `task-mandate`. Runs in browsers, Cloudflare Workers, and Node.js without file or process APIs.

Experimental research implementation (0.1). Not for production.

## Install

```bash
npm i @task-mandate/agent @task-mandate/core
```

## Example

```ts
import { mandatedFetch, signRequest } from "@task-mandate/agent";

// Refuses to send when the mandate signature fails, aud differs from the request
// origin, or floor(now / 1000) >= exp + 30. A refusal throws TaskMandateError
// INPUT_INVALID. Redirects are not followed.
const res = await mandatedFetch(
  "https://court.example/reserve",
  {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ facility: "court-3" }),
  },
  { mandate, agentKey: agentPrivateJwk },
);

// Signs without checking the mandate, for example to build a request the
// server should reject in a test. The body cap defaults to 2 MiB.
const signed = await signRequest(
  new Request("https://court.example/reserve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ facility: "court-3" }),
  }),
  { mandate, agentKey: agentPrivateJwk },
);
```

## License

Apache-2.0
