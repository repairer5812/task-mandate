# Contributing

## Setup

Node.js 22 or later and pnpm.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
```

## Before opening a pull request

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm test:worker
```

`pnpm release:check` runs the full release gate: build, unit and Worker tests, typecheck, vector regeneration, the scenario lab, 20 Durable Object concurrency runs, property tests, a packed install of the quick start, a dependency license and secret audit, the repository hygiene tests, and the CI status of the current commit. It needs `gh` authenticated for this repository. It is slow and is not required for every change.

## Changing the protocol

1. Change [docs/SPEC.md](docs/SPEC.md) first. Keep [docs/SPEC.ko.md](docs/SPEC.ko.md) in step; the English text wins if they differ.
2. Add or change an acceptance test that fails before the change.
3. If a reason code or its order changes, regenerate the vectors with `pnpm build && pnpm vectors` and explain the diff.

## Style

Short sentences. Comments explain why, not what. No marketing words. Biome enforces formatting.

## Security issues

Do not open a public issue. See [SECURITY.md](SECURITY.md).
