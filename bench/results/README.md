# Measurements

Run on 2026-11-25. Node v26.13.1, CPU AMD Ryzen 7 9800X3D 8-Core Processor. The three local files have no `cf-ray` and no datacenter code. The two `_live` files measure the deployment at https://task-mandate-demo.repairer5812.workers.dev on the same day.

A percentile is the value at position `ceil(p/100*n)` after sorting the sample ascending. The first position is 1.

| File | Target | Repeats | Summary |
| --- | --- | --- | --- |
| 2026-11-25_verify-local.json | same process | 5000 | mandate only p50 0.242ms, p95 0.319ms, p99 0.429ms. person attestation p50 0.357ms, p95 0.459ms, p99 0.592ms. one per person p50 0.356ms, p95 0.43ms, p99 0.528ms |
| 2026-11-25_edge-rtt.json | http://127.0.0.1:8787 | 200, interval 50ms | slots p50 7.373ms, p95 8.249ms. reserve p50 21.384ms, p95 24.462ms. both 200 of 200 returned 200. difference p50 14.011ms, p95 16.213ms |
| 2026-11-25_stop-latency.json | local, fake clock | chunk 30s, 5 runs | theoretical bound 60s (chunk 30 + clockSkewSec 30). observed 59, 53, 54, 58, 47s. max 59s, mean 54.2s |
| 2026-11-25_edge-rtt_live.json | deployment, response colo KIX | 200, interval 50ms | slots p50 100.686ms, p95 106.948ms. reserve p50 377.448ms, p95 404.695ms. both 200 of 200 returned 200. difference p50 276.762ms, p95 297.747ms |
| 2026-11-25_stop-latency_live.json | deployment, real clock | chunk 30s, 5 runs | theoretical bound 60s. observed 50.64, 59.781, 47.748, 49.789, 57.058s. max 59.781s |

The `edge-rtt` difference approximates time in verification and the store. The round trip also includes local HTTP and serialization.

A Durable Object handles site requests one at a time. These runs are sequential requests 50 ms apart, so they are not a throughput limit.

The local `stop-latency` run moves the clock by 1 second. Requests are also 1 second apart, so an observation can be up to 1 second over the theoretical bound. These 5 runs stayed within the bound.

Neither live file records which datacenter holds the Durable Object.
