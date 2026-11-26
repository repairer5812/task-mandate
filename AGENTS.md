# Notes for coding agents

These rules apply to people and coding agents alike. See [CONTRIBUTING.md](CONTRIBUTING.md) for the workflow.

- The contract is [docs/SPEC.md](docs/SPEC.md) plus the acceptance tests in `tests/acceptance*.test.ts`. Do not edit acceptance tests to make a change pass. If the spec and a test disagree, stop and say so in the pull request.
- Keep protocol logic in `packages/core`. It has no I/O and uses WebCrypto only. The other packages are thin: `agent` signs and sends, `hono` adapts the verifier to Hono, `cli` is the `tm` command. `packages/node` is a private compatibility package.
- Use `web-bot-auth`, `http-message-sig`, and `@sd-jwt/*`. Do not implement signatures, SD-JWT, or JWK thumbprints by hand.
- Wire names (claims, headers, `vct`) live only in `packages/core/src/profile.ts`.
- Keep files under 350 lines. No network calls, file writes, or key generation at import time.
- Never commit private keys. The fixed keys in `vectors/keys.json` are test-only.
