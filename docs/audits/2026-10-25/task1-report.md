# Task 1: safe keys and verified writes

Implemented locally in the isolated worktree. No live Priority request, ERP mutation, operational CLI execution, deployment, restart, or commit was performed. Tests use synthetic credentials and stubbed fetch. The original untracked helpers in the starting checkout were not modified.

## Changes

- Added `RecordKey`/`NamedKeys`, exactly-one scalar/named-key validation for generic and attachment tools, full known-schema key checks, metadata-backed key discovery for unknown named-key requests, finite numbers and safe identifier checks. Unknown-form previews remain offline and explicitly defer schema discovery until actual execution.
- Existing client methods accept named keys compatibly; added public `getComposite`, composite parent sub-form reads/inserts/updates, uncached read options, and `priority_update_line`. Real line updates validate row keys from parsed sub-form metadata before PATCH.
- Shared write verification reports `status`, `acknowledged`, `verified`, expected/observed fields and failure reasons. All writes in owned generic/orders/customers/impfiles/documents tools now set success booleans only after matching uncached readback. Lost write responses remain unknown without automatic retry. A readback failure preserves acknowledgment and generated document identifiers.
- No-op cancel/update/close/reopen/link operations return false success flags. Reopen requires the actual requested fields, rather than merely an arbitrary status other than closed. Existing `verifiedAfterWrite`, attachment `created`, and generated-record payloads remain additive response fields.
- Line/attachment POST verification requires a returned row identifier and a matching read of that row; a matching older description alone never verifies an insert. Attachment verification describes row evidence only, with file bytes/path accessibility explicitly unverified.
- `listNext<T>(nextLink,{signal?})` is GET-only, uncached, exact origin/company scoped, denies credentials/fragments, raw or repeatedly encoded traversal, and redirects. Entity and query builders reject traversal and query-slot path injection.
- Client read APIs support caller `AbortSignal`; in-flight fetch and retry delay cancel without another request. A request aborted while waiting for a rate-limiter slot is checked again before fetch. The rate-limiter wait itself is not interrupted.
- Order/import-file range filters use validated half-open `dateRange` bounds before requests (coordinated with Task 2).
- Replaced absolute-path/private-send/read-only-override helpers with import-safe portable modules, preview by default and explicit `--confirm` plus unchanged config/client guards. Finalization helper is an unavailable guide: no mapped/tested procedure means a STATDES write cannot establish finalization. Old helper delete operations intentionally fail as unsupported.

## Regression evidence

- Initial `npx vitest run tests/verified-writes.test.ts`: **10 expected failures**, including no-op success, readback acknowledgment loss, composite contracts, traversal validation and missing continuation API. Implemented and observed green.
- Added import-file reopen/header/PO-close regressions: **2 expected failures**, then green.
- Helpers initially failed upon import because the original script executed config loading and process.exit at module scope. Replacement imports have no operational side effects; previews and read-only gates pass offline tests.
- Empty PATCH / multiply encoded entity traversal / query-slot path injection: **3 expected failures**, then green.
- Cancellation tests: **3 expected failures** (already-aborted fetch still ran, in-flight request waited for timeout, retry backoff issued 3 fetches), then green.
- Direct known-key completeness check and deep-insert readback expansion each failed before implementation, then passed.

## Verification

- `npx vitest run tests/verified-writes.test.ts tests/write-helpers.test.ts tests/client-cancellation.test.ts tests/composite-key.test.ts tests/subform-row.test.ts tests/impfiles-logic.test.ts`: **69/69 passed** before the final extra deep-insert regression (now 70 focused tests).
- `npm test`: **297/297 passed, 29 files** before final deep-insert regression.
- `npx tsc --noEmit`: **passed**, including after final changes.
- `npx biome check --write` on all 13 owned source/helper/test files: **passed**; final 4 changed files also passed.
- Final whole-suite run and final counts are recorded below after execution.

## Deliberate boundaries / review notes

- Unknown create schemas, missing returned identities, unsupported line identifiers, normalized Priority field values or incomplete readback produce `unverified`, preserving the write response. The code does not guess a created identity or retry to obtain one.
- Static verified schemas are accepted where present; otherwise real named-key requests require parsable metadata. No test-company round trip was authorized or performed, so actual ERP write/procedure availability remains unproven.
- Preview and blocked outcomes returned by shared `write-guard.ts` are root-owned; root was notified to add the full common outcome fields there as part of result-contract integration.
- Ruling: the finalization helper becomes a blocked guide rather than preserving unverified status-description writes, because the design explicitly forbids presenting unsupported lifecycle semantics as executable completion.

## Final review corrections (additional root-authorized scope)

- Reviewer reproduced an in-flight cache race. Added three regressions and observed all three fail: a GET during held PATCH stayed cached after verification; a pre-write GET completed after the write and refilled stale cache; a lost-response write left a related OBLIGO cache stale. Added cache generations and a central mutation fence. All attempted mutations clear the whole tenant cache before and in `finally`, including ambiguous failures; active writes bypass cache and older GET completions cannot populate a newer generation. This conservatively covers derived/cross-form effects.
- Root extended write-only ownership to invoice/credit and purchase-order create handlers. They now use shared create verification while preserving invoice/creditMemo/purchaseOrder identities. Invoice and purchase-order false-success regressions observed red then green.
- Generic query preserves short-page `@odata.nextLink` as `nextLink`, sets `hasMore:true` when supplied, and marks no-link short-page completeness unknown (`hasMore:null`). A short-page continuation regression observed red then green.
- `npx vitest run tests/cache-write-race.test.ts tests/cache.test.ts tests/verified-writes.test.ts`: **34/34 passed**; `npx tsc --noEmit`: **passed** after these corrections.

## Latest whole-suite integration check

At 10:41 local tool time, `npm test` ran during root's additional reviewer-fix TDD: **305 passed / 3 failed, 31 files**. Failures were outside Task 1: `tests/capability-probes.test.ts` supplier invoice required-form probe and simultaneous refresh concurrency; `tests/capability-results.test.ts` directly nested array omission metadata. Root was notified and owns these fixes. `npx tsc --noEmit` and Biome on all **17** Task 1/extended-scope files passed in the same check. Earlier whole suite was green at 298/298 before these new root regressions were introduced.
