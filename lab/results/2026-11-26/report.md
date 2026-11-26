# Lab results

Ran in-process. 20 seeds, 200 people, 7 simulated days, 3 sites.
Started 2026-11-26T02:50:22.239Z, finished 2026-11-26T02:50:37.517Z, elapsed 15.3s.

## Scenarios and requests

Task scenarios 4900, attack scenarios 622.
Requests 12990, allowed 8644, denied 4346.

## Reason codes

| Item | Count |
| --- | ---: |
| BODY_TOO_LARGE | 20 |
| EXPIRED | 420 |
| KEY_MISMATCH | 20 |
| LIMIT_EXCEEDED | 322 |
| MANDATE_MALFORMED | 40 |
| NOT_YET_VALID | 20 |
| PERSON_INVALID | 40 |
| REPLAY | 1762 |
| SIG_INVALID | 782 |
| SUPERSEDED | 900 |
| TASK_NOT_ALLOWED | 20 |
| allow | 8644 |

## Invariant violations

0 violations. At most two examples of the same rule are kept per seed. The count includes every hit. The event log is in summary.json.

None.

## Legitimate request denials, by design

| Category | Code | Count |
| --- | --- | ---: |
| clock | SIG_INVALID | 742 |
| expiry | EXPIRED | 400 |
| person slot | SUPERSEDED | 900 |
| replay | REPLAY | 1742 |

## Legitimate request denials, bug candidates

None.

## Attack reason codes

| Category | Code | Count |
| --- | --- | ---: |
| expiry second | EXPIRED | 20 |
| just before nbf | NOT_YET_VALID | 20 |
| long identifier | MANDATE_MALFORMED | 20 |
| other site | PERSON_INVALID | 20 |
| over action limit | LIMIT_EXCEEDED | 20 |
| over chunk limit | LIMIT_EXCEEDED | 302 |
| oversized body | BODY_TOO_LARGE | 20 |
| oversized mandate | MANDATE_MALFORMED | 20 |
| pasted attestation | PERSON_INVALID | 20 |
| replayed signature | REPLAY | 20 |
| stolen mandate | KEY_MISMATCH | 20 |
| swapped body | SIG_INVALID | 20 |
| tampered header | SIG_INVALID | 20 |
| wrong task type | TASK_NOT_ALLOWED | 20 |

## Rejected at issue

None.

## Latency

p50 0.48ms, p95 0.73ms, max 10.42ms.

## Store

Peak nonces 7, actions 26, people 25.
After finish, nonces 0, actions 0, people 0.

## Property tests

Mandate tamper 1000 runs, allowed 0, exceptions 0.
Time order 4004 runs, mismatches 0, boundary failures 0.

## By seed

| Seed | Requests | Violations | Time (ms) |
| ---: | ---: | ---: | ---: |
| 1 | 653 | 0 | 891 |
| 2 | 650 | 0 | 714 |
| 3 | 648 | 0 | 693 |
| 4 | 631 | 0 | 688 |
| 5 | 657 | 0 | 677 |
| 6 | 651 | 0 | 666 |
| 7 | 666 | 0 | 663 |
| 8 | 655 | 0 | 670 |
| 9 | 637 | 0 | 653 |
| 10 | 646 | 0 | 644 |
| 11 | 654 | 0 | 647 |
| 12 | 646 | 0 | 650 |
| 13 | 664 | 0 | 672 |
| 14 | 655 | 0 | 644 |
| 15 | 629 | 0 | 619 |
| 16 | 659 | 0 | 658 |
| 17 | 637 | 0 | 687 |
| 18 | 648 | 0 | 642 |
| 19 | 654 | 0 | 649 |
| 20 | 650 | 0 | 641 |

## Not checked here

Durable Object concurrency and the real clock are recorded in the lab:worker result. Store size in this file is the in-memory store only.
