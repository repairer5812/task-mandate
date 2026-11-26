# @task-mandate/hono

Hono verification middleware (`taskMandate`) and types for `task-mandate`. `store` is required. The middleware refunds the consumed action count if the route handler throws or returns a non-2xx status code.

Experimental research implementation (0.1). Not for production.

## Install

```bash
npm i @task-mandate/hono @task-mandate/core hono
```

## Example

```ts
import { Hono } from "hono";
import { memoryStore } from "@task-mandate/core";
import { taskMandate, type MandateEnv } from "@task-mandate/hono";

const app = new Hono<MandateEnv>();
const guard = taskMandate({
  origin: "https://court.example",
  store: memoryStore(),
});

app.post("/reserve", guard({ requireTask: { type: "reserve", resource: "court-3" } }), (c) => {
  const mandate = c.get("mandate");
  return c.json({ ok: true, principal: mandate.principal, task: mandate.task });
});
```

## License

Apache-2.0
