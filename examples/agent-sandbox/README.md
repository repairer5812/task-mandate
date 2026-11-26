# Test Task Mandate with an AI agent

English | [한국어](README.ko.md)

The public mock API accepts signed HTTP requests from an AI agent or a Node.js program. This example uses `@task-mandate/core` and `@task-mandate/agent` 0.1.0. It needs Node.js 22 or later and network access to GitHub, npm, and the demo server. You can run it without an account or API key.

```sh
git clone https://github.com/repairer5812/task-mandate.git
cd task-mandate/examples/agent-sandbox
npm ci --ignore-scripts
npm test
```

If an AI agent is running the test for you, give it this folder's GitHub URL and ask it to run these commands once and report both HTTP results.

- The script generates two temporary Ed25519 keypairs, then sends the principal's public key to `POST /sim/attest` on the [public sandbox](https://task-mandate-demo.repairer5812.workers.dev).
- It issues a 120-second mandate for one mock application and sends two requests to `POST /civil/apply`. Both requests use the same mandate and each has a fresh signature and nonce.
- Expect HTTP `200` with an `MO-` receipt, then HTTP `403` with `LIMIT_EXCEEDED`.

Use synthetic data. This mock service records outcomes in a public demo log. The [API notes](../../docs/DEMO.md) list the available services and IP rate limits. If you get HTTP `429`, wait until the published limit window has passed before running the example again.
