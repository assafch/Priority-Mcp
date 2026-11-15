# Live compatibility fixes — 2026-10-25

Source commit: `cebeda93f33b0e5523f224a01a2e15b85d56d116`. Status: **local fixes implemented and live read-only checks passed**. No ERP writes, deployment, restart, package publication or new remote push. This follows the [offline implementation record](faster-smarter-verification.md); its historical measurements are unchanged.

## Fixed behavior

1. **Report line schemas:** Priority supports targeted `GetMetadataFor` only for top-level forms. The report reader now resolves child types through the parent's declared navigation and one shared full `$metadata` read. It verifies complete source keys, preserves cancellation isolation and caches raw plus parsed schemas within a shared 16 MiB budget. This uses the [documented Priority restriction](https://prioritysoftware.github.io/restapi/request/), not a guessed child name.
2. **Order document links:** both shipment entrypoints use schema-verified `DOCUMENTS_D` with exact `ORDNAME`, full document keys and bounded continuation. No `SHIPMENTS_SUBFORM` expansion remains in these readers. Direct-link coverage is separate from overall shipment history: multi-order links remain unverified, overall `complete` remains false, and `deliveryVerified` remains false. The legacy `shipments` field is explicitly an alias of ERP document headers.
3. **Queued process lifetime:** pending scheduler wake/deadline timers remain referenced until work settles. Admission, abort, deadline and close release the handles. The profiler persists partial evidence and exits nonzero for incomplete requested work; a completed small run remains distinct from sufficient p95 evidence.

## Fresh live evidence

The [functional record](live-fixes/verification.json) contains **7 successful checks, 16 GET requests, all HTTP 200**, with zero non-GET requests sent. A preceding discovery read fetched the full schema once. No business values, document identifiers, customer identities, credentials or service URLs are included in these published artifacts.

- Actual invoice-line key: `KLINE`; delivery-line keys: `KLINE,TYPE`. One full-schema read served both; the repeated child-schema lookup made zero network requests.
- An independent bounded source read covered 7 final invoice headers and 4 matching lines. The selected product/day invoice report exactly matched that source quantity. This verifies the chosen sample, not all products or dates.
- The combined invoice/delivery sample returned complete coverage with no missing windows; `snapshotConsistent:false` remains explicit. Its combined total was not independently reconciled.
- Both legacy and workflow shipment paths returned ERP document arrays with direct-link coverage complete, overall history incomplete and customer delivery unverified.

The [standalone profiler](live-fixes/profile-summary.json) completed without an external keepalive: **50 cold live reads and 50 warm cache reads**, no failures, exit 0, maximum 30 request starts in any rolling 60 seconds. Cold p95 **2085.862 ms** includes deliberate pacing/queue time; response-header p95 **789.822 ms** is a different measure. Warm p95 **0.044 ms** had zero backend calls and is not an independent ERP observation. No cross-run speedup or model/token gain is claimed.

Cold full-schema response headers took **38.889 seconds**; the entire first parent/child schema check took **42.771 seconds**. Caching removes that repeat cost, but the initial full metadata request remains expensive.

Live artifacts recorded base HEAD `cc76942` while the reviewed changes were uncommitted; they exercised the working implementation subsequently committed above. Full private schema and original live scripts/logs remain in ignored/local evidence directories. Published data contains counts, timings, schema names and assertions only.

## Local verification and review

| Check | Result |
| --- | --- |
| Native Node 26.4.0 suite | 500 tests / 54 files passed |
| Node 22.13.0 and Node 24 | Each: 500 tests / 54 files and TypeScript check passed |
| Build, lint, whitespace | Passed; Biome 170 files |
| Stdio smoke | 110 tools; previews and write guards passed; zero ERP calls |
| Offline Docker smoke | Build passed; health 200; anonymous MCP 401; authenticated initialize 200; test container removed |
| Package | npm pack dry-run passed; dependencies unchanged |
| Independent source review | Approved, no outstanding Important or Minor findings |

The initial concurrent Node matrix plus Docker build exceeded the unchanged HTTP 100-session test's 5-second timeout on both Node versions. Sequential reruns of the same commands passed without modifying that test or its timeout. This execution contention is disclosed rather than hidden.

The process regression also restored the old timer behavior temporarily and reproduced premature exit after 30 synthetic GETs with no artifact. Restored fixed source completes all 50; abort/close release the long timers. All process fixtures are offline.

## Frozen evaluation boundary

The [engine evaluation](live-fixes/evaluation.json) is **118/120 raw passes**, with **2 registered contract deviations and 0 other failures**. Cases `workflow-report-018` and `workflow-report-027` retain their literal `complete:true` expectations; the corrected shipment behavior reports false because direct document links cannot prove complete multi-order shipment history. No frozen base file, expected economic fact or source-identity sidecar changed. Only the metadata transport fixture now follows Priority's top-level/navigation schema shape.

Acceptance is limited to that single fact in those two cases. A new negative control adds a wrong delivery-verification expectation and remains blocking. This is not 120/120 raw accuracy. Host/model trials remain unrun.
