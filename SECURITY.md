# Security Policy

## Status

task-mandate is experimental research code (0.1). It is not for production use. It has had automated review only. No independent human security audit has been done.

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | Yes (experimental) |
| < 0.1.0 | No |

## Reporting a vulnerability

Use GitHub private vulnerability reporting on this repository (Security tab, Report a vulnerability). Do not open a public issue or pull request for an undisclosed vulnerability.

## Known limitations

- The person attestation helpers (`issuePersonAttestation`, `tm idp`, and the demo's `/sim/attest`) are a mock identity provider. They do not verify anyone's real identity.
- There is no revocation. Stopping a task stops renewal, and the last chunk stays valid until `exp + clockSkewSec`.
- Websites see the principal key thumbprint (`iss`) and the agent key thumbprint (`keyid`). Reusing a key across websites lets them link requests, even when attestation subjects differ per website.
