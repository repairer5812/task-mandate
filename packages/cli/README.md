# @task-mandate/cli

Command-line tool (`tm`) for `task-mandate`: Ed25519 key generation, single-mandate issuance and inspection, long-running chunked task delegation (`delegate`, `run`, `list`, `stop`), and mock identity provider attestations (`idp keygen`, `idp attest`).

Experimental research implementation (0.1). Not for production.

## Install

```bash
npm i -g @task-mandate/cli
```

## Example

```bash
tm keygen --out me.json
tm keygen --out agent.json

tm issue \
  --principal-key me.json \
  --agent-pub agent.pub.json \
  --site https://court.example \
  --task reserve \
  --resource court-3 \
  --max-actions 1 \
  --duration 30m \
  --out mandate.txt

tm inspect mandate.txt
```

`tm inspect` prints `status` `verified` or `UNVERIFIED`. `UNVERIFIED` means the file decoded but the mandate failed the shape or signature check. `tm stop` prints the output file's `exp` as ISO 8601 with a timezone. `--max-actions` must be an integer greater than or equal to 1. `--site` must be an http or https origin with no path.

## License

Apache-2.0
