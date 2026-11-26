# Worker concurrency test

Local wrangler dev, real clock. The concurrency checks ran 20 times. The over-time scenario ran once. Elapsed 113.2s.
Renewal chunk 40s, renewal task 120s, minimum switch 20s.

50 concurrent requests, limit 7, allowed 7. Codes: LIMIT_EXCEEDED 13, allow 7, http-429 30. The 30 requests hit the demo's 20-per-minute IP limit before verification.
Same nonce allowed 1. Codes: REPLAY 1, allow 1.
Same person concurrent allowed 1. Codes: SUPERSEDED 1, allow 1.

No concurrency violations.

Requests over time 15, allowed 11, denied 4, violations 0.
p50 7.13ms, p95 9.45ms.

Whether the store grows over time was not measured in this mode.
