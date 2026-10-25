# Faster and smarter MCP — verification record

Implementation date: 2026-10-25. Baseline: `29f89590b567db66949564ac2c083d65dfc6f772` (0.2.0). Implementation branch: `codex/mcp-faster-smarter-20261025`. Core source and independent review are complete; final clean-revision benchmark/evaluation recording is in progress.

## Scope and result boundary

Tasks 1–9 and the offline portion of Task 10 are implemented: measurement, search correctness, scheduling/coalescing, schema/capability sharing, compact discovery/results, entity resolution, typed query preparation, read workflows, report continuation and deterministic evaluation. The persistent index, batch transport, vendor adapter, webhook/distributed coordination and protocol upgrade remain optional gated extensions.

No `.env` was read or copied. No live ERP request/write, message send, deployment, host restart or live profiling was performed. Fixtures are synthetic. Stdio and HTTP checks use local transports/listeners. Host/model performance and actual tenant metadata compatibility remain unmeasured. This is **offline-complete / live-performance-unverified**, not a live release.

## Verification

| Check | Result |
| --- | --- |
| Full suite, native Node 26.4.0 | 473 tests / 50 files passed |
| Node 22.13.0 | 473 tests / 50 files passed; TypeScript check passed |
| Node 22.23.4 | 473 tests / 50 files passed; TypeScript check passed |
| Node 24.22.1 | 473 tests / 50 files passed; TypeScript check passed |
| Build and lint | TypeScript build passed; Biome 164 files clean |
| Stdio protocol smoke | 110 tools; previews and write guards passed; zero ERP calls |
| Loopback HTTP | Included in full suite: authentication, sessions, policy and pooled-client cleanup |
| Docker | Build passed; health 200; anonymous MCP 401; authenticated initialize 200 with verified serverInfo |
| Dependency/package checks | npm audit: 0 vulnerabilities; npm pack dry-run passed; diff whitespace check clean |

Docker image: `sha256:cbb5c38f933dc318364793d82e57b67e218b36a9e1dd341edcabb0b04d214bcd`. The synthetic test container was removed after verification. Source package remains unreleased 0.2.0; no package publication occurred.

Final clean-revision measurement artifacts and local integration revision will be recorded in the evidence commit.

## Independent review and repairs

The reviewer required fixes rather than accepting partial behavior. All Important findings are closed after scoped re-review:

- Foundation F1–F7: sensitive cache TTL and true observation age; heavy discovery classification; complete compact-tool warnings; unknown import values; explicit bounded order-line support; removal of an unscoped duty-free assumption; shared same-data-scope write invalidation across client instances without sharing payloads or policies.
- B1: current-call formatting previously overwrote authoritative older source timestamps. The regression first failed, then passed after preserving source evidence and separating new request observations.
- Report R1–R4: missing/null nested sources, complete metadata-backed parent/line identity, unknown selected measures, source-safe detail pagination and actual successful-read observation ranges. Unknown sources are incomplete and unsummed; repeated physical source identities contribute once; distinct equal-valued lines remain distinct.
- Schema/capability review: subscriber cancellation isolation, caller-local traces, warm cancellation checks, truthful partial metrics and canonical metadata resource policy.

The [final independent review](faster-smarter-final-review.md) approved the source and separately assessed the evaluation identity sidecar. Scope-aware targeted regressions preceded fixes. Report-specific final validation: 61 tests / 5 files passed. Fifty synthetic real-client report runs preserve the literal total and at most two active heavy reads: 454 backend calls = 450 data reads + 4 once-per-client parent/child metadata reads. The added identity-verification work is counted, not hidden.

## Evaluation provenance

The dataset has 120 engine cases: 40 entity, 30 query, 30 workflow/report, 20 guard; 80 development and 40 held-out. Initial execution was 118/120. Manifest v2 corrected two development oracle defects: reversed date ranges reject semantically rather than by one literal error word; absent import valuation sources leave landed cost incomplete. Base held-out bytes stayed unchanged.

Stricter source-identity validation later exposed incomplete synthetic sales fixtures. A separately reviewed `synthetic-source-identities-v1` sidecar supplies literal opaque line identities and targeted parent/child metadata to exactly 11 cases (9 development, 2 held-out), matching 20 parent observations and 21 physical line bindings. It does not derive identity from amounts/SKUs or invent quantities, money, statuses or duty facts. The base files and expected outcomes remain unchanged, but **effective protocol inputs changed**. This is a protocol-enriched evaluation, not the identical original held-out experiment. Sidecar-disabled, missing parent/line key and missing child-schema controls remain incomplete; a deliberately wrong oracle also fails.

| Evidence | SHA-256 |
| --- | --- |
| Frozen development base | `ee18e14fd47b66afe05b32924ca0492896c9ddb0acb9bbeb4deeac1622fa3d1f` |
| Frozen held-out base | `a740f19ab1cf613505400617eb475291429ce65c1c9fa1ef1dab363c97b4cf73` |
| Source identity sidecar | `3792c355a93d2747aa7b3cd807f0556e76d8a15f0f124fff82a6a755479ea9eb` |

These are deterministic engine inputs, not 120 LLM conversations. Host target choice, assistant-call reduction and token usage remain unmeasured. The delivered live profiler requires explicit activation/scenarios, limits actual attempts to 200/run and 30/minute, and withholds p95 below 50 successful comparable observations. It was not run live.

## Integration decisions and limits

1. User execution authorization covers reversible local source/tests/docs, commits and integration into the original `feat/impfiles-import-management` checkout. Remote publication and live activation remain outside this run.
2. Native worktree creation failed because the workspace root is the repository parent. A manually created isolated worktree preserved existing worktrees. Root owns coherent integration commits; local review evidence is retained.
3. Schema resources require canonical `priority_get_entity_metadata` policy even when cached; narrow resource-only allowlists must explicitly include this dependency. Profile visibility does not authorize reads.
4. Workflow identity is null until an uncached exact read verifies it. Order diagnosis preserves shipment-only defaults; explicitly request both lines and shipments for the new line capability.
5. Actual Priority targeted parent/child metadata and expansion shapes, live quotas/latency, host/model replay and deployed readback require the separate live stage. Unavailable report identity metadata yields honest incomplete results rather than guessed totals. No multi-process quota coordination or database snapshot consistency is claimed.
