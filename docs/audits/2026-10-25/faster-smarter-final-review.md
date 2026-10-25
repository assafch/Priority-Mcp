# Final scoped re-review — 2026-10-25

**Approved for specification compliance and code quality in the reviewed scope. No unresolved Critical or Important finding remains from this review series.** Task 9 R1–R4 are addressed; foundation F1–F7/B1 were closed by the prior scoped reviews. Task 10's inspected offline implementation and separately versioned identity enrichment are approved with the evidence qualifications below. Final integrated verification remains the root agent's gate; this report is not a deployment/live-performance approval.

Reviewed current Task 9 source/tests, `final-fix-report.md`, `task-9-final-fix.txt`, current evaluation adapter/test/identity-sidecar files, and the Task 10 Docker/profiler minor changes. No source edits, commits, live/network calls, `.env`/credential reads or subagents. Only this report was written. Reported suites were not rerun. A small read-only fixture/hash audit independently checked sidecar bindings and original frozen file hashes; it did not rerun engine evaluation.

## Task 9 disposition

| Finding | Spec compliance | Quality | Current implementation evidence |
| --- | --- | --- | --- |
| R1 missing expansion/full parent identity | Addressed | Approved | Expanded collections must be arrays; missing/null/malformed sources remain incomplete. Targeted scoped parent metadata supplies every declared key, required invoice/document identity fields remain included, keys are projected/ordered and validated on returned rows. Missing selected numeric measure is incomplete/unsummed; explicit zero and negative credits remain valid. Empty valid collections remain empty evidence. |
| R2 nested identity/deduplication | Addressed | Approved | Targeted child metadata establishes key names; nested projection/order includes them. Parent context and all child keys form the deduplication identity. Duplicate keys contribute once; equal-valued distinct identities remain separate. Missing metadata/keys stays incomplete without SKU/amount/index fallback. |
| R3 retained-detail evidence | Addressed | Approved | SalesState retains source evidence/warnings. Tool detail and independently readable resource pages include the original completeness, missing windows and observation range. Output/page completeness is separate. Report formatting uses source-preserving bounds directly, so another default formatting pass cannot relabel display truncation as source incompleteness. |
| R4 unread observations/nested coverage | Addressed | Approved | Unread/failed contributions start with null observation timestamps. scanStartedAt is separate. Source observation range advances only after successful response reads. expandedLinesComplete is an independent field, set false for missing source identity/shape/measure, header coverage gaps and nested interruption/error paths. |

The fix tests directly cover the original failures, complete parent-key extension, unknown selected measures, valid empty/zero/negative cases, repeated nested identities versus distinct equal lines, metadata unavailable, already-expired reads, nested failures, and incomplete evidence in both detail interfaces. Existing literal report expectations remain intact in the supplied fixture changes, including replacement/full-refresh and invoice/delivery semantics.

The reviewed runtime still uses exact per-source/window contributions for resume replacement, last-complete plus partial/missing rereads, explicit retained-window caveats, shared deadline/cancellation, at most two active report windows, and token-bound throttled progress. No change in these fixes introduced a new blocker. Targeted parent/child metadata adds counted backend work; the report correctly discloses four once-per-client metadata requests in the 50-run synthetic fixture rather than hiding them as a latency gain.

Handle isolation remains bound to policy, query, generation and per-client incarnation. Shared live data-scope generation/fencing and incarnation reset protections complement each other. No report calculation uses formatted/truncated output. Final current-source full-suite, transport and package validation is still required.

## Independent source-identity sidecar assessment

Approved **as a new, separately versioned synthetic protocol enrichment**, not as an unchanged-input rerun of the original held-out experiment.

Independent audit results:

- Original `development.json` SHA256 remains `ee18e14fd47b66afe05b32924ca0492896c9ddb0acb9bbeb4deeac1622fa3d1f`.
- Original `held-out.json` SHA256 remains `a740f19ab1cf613505400617eb475291429ce65c1c9fa1ef1dab363c97b4cf73`.
- The sidecar lists exactly 11 sales cases: 9 development and 2 held-out cases.
- Its declared parent selectors match 20 existing parent observations and 21 literal child-line bindings. Repeated observations of the same physical fixture line reuse the declared identity; separate physical lines have separate identities.
- The adapter uses parent identity values only to locate already-matching source rows. It does not fill missing parent values or change statuses, quantities, monetary values, dates, duty, flags or expected outputs.
- The only injected row property is the explicitly declared nonempty `SYNTHETIC_LINE_ID`; conflicting existing identity is rejected. Schema/key metadata is separately declared and version/hash checked against the base fixture hashes.
- Array position locates the static fixture row whose literal identity is separately declared; it is not used by production code to generate identity or by the adapter to infer equality from economic values.

The evaluation result records the sidecar version/hash, applied case IDs and `effectiveInputsChanged:true`. These disclosures must remain in any final artifact/summary. A reported 120/120 score with this sidecar demonstrates the enriched deterministic synthetic protocol fixtures, not pristine original held-out inputs, tenant accuracy, host/model choice or live performance. Earlier raw-input failures remain meaningful evidence that the stricter production engine refuses unverified source identity.

The tests retain a sidecar-off raw-input negative control and separately remove a child key, parent key or child schema key after enrichment. Each expects incomplete/unsummed output, proving that the sidecar is not a production fallback and does not disable strict guards. Frozen economic expectations remain literal; the negative controls have their own explicit incomplete expectations rather than weakening the original totals.

The sidecar manifest currently says independent review pending; this report supplies that review. Root may update its review-status documentation to reference this approval without changing the reviewed identity content, hashes or economic oracles.

## Task 10 minor items

- Docker CI now verifies anonymous `/mcp` returns 401 and authenticated initialize returns serverInfo for priority-mcp-server. It therefore goes beyond public `/health` liveness. This closes the prior documentation/probe mismatch by inspection; actual final Docker execution is not claimed by this reviewer.
- The live profiler now records opaque scenario/workload SHA256 fingerprints and non-secret effective runtime settings alongside the existing actual-attempt and cache-state metrics. The prior explicit-live/scenario gate, GET-only enforcement, <=200 actual attempts and <=30/minute pacing remain. This closes the reproducibility note without copying source keys/queries into result data. No live profiler run occurred.
- Deterministic evaluation continues to label host/model trials not-run with accuracy/assistant-call/token metrics null. No live speedup, production activation, bank clearing or carrier delivery evidence is implied.

## Final evidence boundary

The implementer reports 61 focused Task 9 tests across five suites, build and scoped Biome passing, and 120/120 enriched engine evaluation. Those results were inspected, not independently repeated. Root owns the final integrated tests/build/lint/stdio/HTTP/package/Node/Docker runs on the final revision and any nonbehavioral formatting/documentation reconciliation.

No approval is given for post-review behavioral changes, live/host A/B performance claims, optional extensions, ERP mutation, deployment or publication. Tenant support for targeted child metadata remains unknown until an authorized live check; the code's safe behavior when it is unavailable is explicit incomplete evidence. Subject to final integrated offline checks, no further review finding blocks completion of the authorized local implementation.
