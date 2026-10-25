# Faster and smarter MCP rollout

Implementation is evaluated offline first. Live Priority latency, host/model tool choice, token consumption and live rate-limit behavior remain **unverified** until a separately authorized pilot. Synthetic engine correctness is not model accuracy. Optional persistent indexes, batch transport, vendor adapters and protocol upgrades are outside this core release.

## Local verification

```sh
npm ci --ignore-scripts
npm run lint
npm test
npm run test:mcp
npm run evaluate:mcp
npm run benchmark:mcp -- --mode=offline --output=artifacts/performance/offline.json
npm pack --dry-run
```

CI exercises Node 22.13, 22 and 24, real stdio/loopback HTTP, deterministic scheduling and deduplication, schema/query contracts and frozen synthetic evaluation. Docker is built and its authenticated HTTP listener smoke-tested. Synthetic latency is recorded with 50 samples and environment/revision details; timing thresholds are not general CI pass/fail gates. Compare identical runner, workload, transport and cache state. Historical planning evidence remains immutable in `docs/audits/2026-10-25/performance/`.

The 120 deterministic engine cases keep their frozen base files and expected answers. A separately versioned, independently reviewed source-identity sidecar enriches 11 sales cases (9 development, 2 held-out) with literal synthetic line identities and targeted metadata. It supplies no quantities, amounts or statuses. Effective protocol inputs changed; this is not a repeat of the identical original held-out experiment. Missing-key/schema and sidecar-disabled negative controls must remain incomplete. See the verification record for hashes and final results.

## Defaults and policy

| Setting | Default | Boundary |
| --- | --- | --- |
| `RATE_LIMIT_PER_MINUTE` |90| Actual attempts including retries, process-local account scope |
| `PRIORITY_MAX_CONCURRENCY` |4| Active attempts across account-sharing clients |
| `PRIORITY_MAX_PENDING` |100| Cancellable pending requests; overflow rejects |
| `PRIORITY_REPORT_CONCURRENCY` |2| Independent report windows;1 rolls back parallel windows |
| `PRIORITY_COALESCE_READS` |true| Identical cacheable GETs only;false preserves response caching |
| `PRIORITY_TOOL_PROFILE` |full| `operations` exposes up to25implemented read-focused tools |
| `CACHE_MAX_BYTES` |33554432| Response cache additionally caps500 entries and skips entries>2MiB |

Account quotas are shared across companies/languages when deployment and authentication identity match. `PRIORITY_RATE_SCOPE` can group different credentials representing the same upstream account; it never merges their data. Active configurations use the strictest shared limits. Multiple processes and unrelated integrations require separate capacity planning. Explicit configured rate limits remain respected.

Interactive/verification operations default to20 seconds; reports/discovery120 seconds. Existing report `deadlineMs` can explicitly request up to300 seconds. Queueing, body consumption and retry delay all count. Business cache TTL is at most60 seconds; recognized finance/stock reads at most15 seconds. Parsed metadata has1 hour soft / 24 hour hard TTL and a16 MiB / 256 entry cap. Stale read schema is labelled; schema-dependent writes require refresh. Capability evidence expires after 5 minutes, authorization/transient uncertainty after 30 seconds.

Profile visibility does not grant permission. Workflows and the resolver check every named legacy dependency against explicit allow/block policy. A workflow-only allowlist cannot read its components until those names are added. Schema resources require the canonical `priority_get_entity_metadata` dependency even when cached. Detailed help is available at `priority://tools/{name}` or `priority_get_capabilities` with `names` and `view:detail` for hosts without resource support.

Order diagnosis defaults to shipment evidence; request `sections:["lines","shipments"]` for bounded order-line state. Sales reports now require targeted parent/child key metadata for trustworthy source deduplication; unavailable metadata or missing keys/selected measures leave unsummed, incomplete evidence. Actual tenant support for these metadata shapes remains unverified offline.

IDs remain exact strings. Fuzzy names produce candidates requiring selection. Reviewed aliases are private scoped configuration with provenance, not model-learned facts. Every emitted resolver candidate is checked against an uncached current exact record; no persistent index is enabled.

## Staged activation and rollback

Activation requires separate authorization and a preserved prior Git revision/package. Build the new artifact locally first. On the authorized deployment, enable runtime/coalescing/schema changes first, resolver/workflows second, then the compact profile and two-window reports. A controlled report stage can start with `PRIORITY_REPORT_CONCURRENCY=1`.

Rollback controls are `PRIORITY_COALESCE_READS=false`, `PRIORITY_TOOL_PROFILE=full`, and `PRIORITY_REPORT_CONCURRENCY=1`. No search index exists, so no index toggle is needed. Roll back schema/runtime behavior by restoring the preserved previous artifact. Restarting invalidates in-memory handles and cached knowledge; clients must start a new query. Restore the reviewed configuration as well as the artifact.

Stop activation on any wrong total, stale write verification, cross-scope disclosure, material 429 increase, or p95 regression>10% for the same measured workload. ERP acknowledgement, a shipment record, and a ledger balance remain distinct from verified write readback, physical delivery, and bank clearing.

## Explicit live profiler

`profile-readonly.mjs` reads inherited environment only; it never loads `.env`. It requires both `--live` and an explicit private scenario file. It enforces GET-only execution, <=200 actual backend attempts/run including retries, <=30 attempts/minute and the shared client scheduler. No tenant-wide metadata discovery, paging, mutation or business-data artifact is allowed. Inputs require literal forms, explicit projections and exact keys or a bounded list top<=100.

Example private synthetic-shaped scenario (replace only after authorization):

```json
[{"kind":"record","form":"CUSTOMERS","keys":{"CUSTNAME":"APPROVED_ID"},"fields":["CUSTNAME"],"samples":50,"cache":"cold"}]
```

```sh
node scripts/profile-readonly.mjs --live --scenario-file /private/approved-scenarios.json --output /private/pilot-result.json
```

The result contains timings/counts only, written with owner-only permissions. Failed/insufficient observations do not receive a p95. Warm-cache samples are not independent ERP observations. If 50 comparable successes cannot fit the authorized budget, use another approved observation period; do not extrapolate a speedup. This script is delivered but is not run during offline implementation.

## Host/model evaluation still required

Freeze host/model versions/settings and replay each of 40 held-out prompts 3 times in both profiles. Capture chosen tools, assistant/backend calls, returned evidence and only host-reported token counts. Targets are >=95% correct target choice, zero fabricated evidence/silent ambiguous selection, and >=40% fewer assistant calls on multi-step cases. Offline fixture pass rates cannot substantiate those targets. Keep full/operations order and cache state recorded; use comparable repetitions before claiming an improvement.
