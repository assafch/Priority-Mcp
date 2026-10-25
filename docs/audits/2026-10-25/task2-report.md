# Task 2 — reports and scan correctness

Local implementation complete for B06, B07, B10, B12 and B16. No real Priority reads or writes were made. Existing test files were preserved; regressions use fixture handlers and mock network/client seams.

## Implemented

- `fetchAllPages` retains array-caller compatibility and adds OData envelope/validated continuation support. Exact row caps include a server that ignores requested `$top`. Scans expose `complete`, `stopReason`, `nextCursor`, `mode`, `pages` and legacy `capped`. Missing continuation handlers and repeated links return explicit incomplete scans. Envelope reads without next links probe by actual returned row counts until an empty page confirms exhaustion; a short server page alone never proves an aggregate complete.
- Cash position scans all cash-flow GL accounts up to an explicit 10,000-account cap. Revenue and customer ranking retain complete composite invoice-key order and safe continuation, with scan metadata and truthful partial-total warnings.
- The unreconciled-invoice tool scans at most 5,000 rows and reports distinct scanned/found/returned counts. It no longer reports “at least 100 open” for a zero-match cap. Only final, non-temporary invoices with an explicitly supplied empty reconciliation date qualify as posted unreconciled signals. Missing source fields make completeness false. Original invoice totals are explicitly not remaining balances; `remainingBalance` stays null.
- Expanded product sales follow both header and nested line next links through the safe client API. Nested loops/caps produce explicit incomplete metadata. Header scan failures do not double-count a partially processed window when splitting. Delivery notes are omitted with an explicit missing-source window if the invoice scan cannot support deduplication.
- Read 408 timeouts split windows immediately; deterministic 501/505 errors are propagated without report retry/backoff. The report accepts an overall `deadlineMs` (default 120,000; maximum 300,000), propagates an abort signal to header and nested client reads, stops additional work on cancellation/deadline, and returns explicit missing windows. The client collaborator added cancellable network/retry support; no long report sleeps remain.
- `dateRange` and `dateRangeFilter` reject malformed/rollover dates and reversed ranges before requests. Date-only upper bounds are the next day's midnight with `<`, including fractional timestamps in the final second. Explicit offsets retain their instant meaning. Reports preserve Priority's returned calendar-date prefix for bucket labels.
- Debt/aging/cashflow guidance consistently identifies `OBLIGO.CREDIT` as customer A/R balances and `OPENINVOICES` as uninvoiced delivery documents. Unsupported due-dated open-item data remains explicitly unavailable.
- Single-invoice details explicitly flag unfinished expanded/header continuation instead of presenting those details as complete.

## Regression evidence

Initial `tests/report-regressions.test.ts` run: **12 failures**, including overshooting 600 rows, dropped envelope pages, false unpaid count/guidance, 200-account cash truncation, malformed dates reaching a request, missing nested lines, 501/505 long retry and unbounded stalled reports. Additional RED-to-GREEN checks covered unfinished invoice detail expansion and exclusion of non-final numeric draft invoices. A source-date offset-boundary test first reproduced the accidental UTC bucket shift (`2026-01-01T00:00:00+02:00` becoming December), then passed after preserving the source business date.

Final fresh verification on 2026-10-25:

- `npx vitest run`: **29 files / 297 tests passed** (2.53s, 10:38:38 local tool timestamp).
- Task-focused dates/pagination/revenue/report suite: **36 tests passed** before final signal wiring; the full-suite run above includes that wiring and cancellation-signal assertions.
- `npx tsc --noEmit`: **exit 0**.
- `npx biome check --write src/lib/paginate.ts src/lib/dates.ts src/tools/invoices.ts src/tools/finance.ts src/tools/debts.ts src/tools/sales-report.ts tests/report-regressions.test.ts`: **7 files checked, no remaining issues**.

## Rulings and evidence boundaries

1. Preserve legacy array-fetch short-page semantics for compatibility, but use OData envelopes for all owned aggregate scans. These scans continue probing short pages. Cost: an extra empty probing request is required when the server supplies no next link.
2. Keep `dateFrom`/`dateTo` legacy outputs compatible and add range-aware helpers rather than silently changing `dateTo`'s operator meaning for existing callers. The parent and safe-write owner coordinate remaining call-site migrations.
3. Preserve Priority source calendar dates for report buckets, with UTC date-only range bounds; this matches existing revenue behavior and avoids moving midnight-offset business documents into the previous period. Parent explicitly agreed; the offset-boundary fixture pins the contract.
4. No fixture proves a tenant exposes correct remaining invoice debt, due dates, or complete undocumented server behavior. Remaining debt stays unknown. OData next-link exhaustion relies on normal protocol semantics; a server silently hiding expanded rows without any continuation annotation cannot be detected offline.
5. Offset/next-link scans are bounded live reads, not a transactional database snapshot. Stable full-key order avoids tie-related offset ambiguity, but concurrent ERP mutations can still change a scan's underlying data.

No deployment, server restart, package change, commit or subagent was performed by this task owner.
