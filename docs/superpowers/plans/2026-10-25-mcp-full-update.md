# Priority MCP Full Update Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Fix the audited defects, expose truthful capabilities, update dependencies and operational documentation, and verify the resulting local MCP release.
**Architecture:** Retain the existing Node/TypeScript MCP server and compatibility for existing tool names. Add shared result, key/verification, capability and HTTP lifecycle modules around the current domain tools. Use bounded discovery for tenant-dependent operations.
**Tech Stack:** TypeScript, MCP TypeScript SDK, Zod, Node 22.13+, Vitest.
**Spec:** `docs/superpowers/specs/2026-10-25-mcp-capabilities-and-bugs-design.md`.

## Global Constraints

- User explicitly authorized implementation with “לעדכן הכל” after the audit; local code, tests, dependencies, build and documentation are in scope.
- No real Priority writes, form activation, publication, deployment or live-server restart in this work.
- Preserve fail-safe read-only defaults, previews before the write guard, no automatic retry of ambiguous writes, and API-disabled versus absent diagnostics.
- All 102 existing names remain accounted for; unsupported ERP semantics remain explicit unavailable results.
- Keep the demo portal a demo. Preserve original untracked helper files in the starting checkout until reviewed replacements are integrated.

## Review Focus

Legacy PAT passed in username; successful no-op PATCH; partial/short/nested pages; same HTTP tenant across multiple sessions; large nested objects and dependency migration schema changes. Every class has regression tests in the owning task below.

## Execution and ownership

The independent problem domains below can run concurrently under `dispatching-parallel-agents`; interface changes are coordinated by the primary agent. Root owns dependency upgrades, result/capability modules and final integration. Changes remain uncommitted until verification; no automated pushes.

### Task 1: Safe keys and verified writes (B03, B04, B08)

Files: `src/client/priority-client.ts`, new `src/lib/record-key.ts`, new `src/lib/write-verification.ts`, `src/tools/{generic,documents,orders,customers,impfiles}.ts`, `scripts/{composite-write,finalize-docs}.mjs`, focused tests.
Interfaces: preserve existing client methods; add public safe composite get/add-line and uncached reads. Generic tool `key`/`keys` exactly-one contract. Verification result `{status,acknowledged,verified,verification}`; success flags only true on confirmed matching readback.

- [x] Write failing tests: no-op generic update/cancel cannot claim success; readback timeout retains acknowledgment and unknown/unverified state; composite get/PATCH/add-line/attachments accept correct keys and reject ambiguity or traversal; helper preview does not write.
- [x] Run targeted tests to observe the expected failures.
- [x] Implement keys and shared write verification, new `priority_update_line`, guarded portable helper replacements; preserve unknown outcome on ambiguous writes.
- [x] Run targeted tests and `npx tsc --noEmit`; inspect any failures from concurrent dependency migration separately.
- [x] Primary reviews diff and records results before integration.

### Task 2: Complete reports and accurate scan metadata (B06, B07, B10, B12, B16)

Files: `src/lib/{paginate,dates}.ts`, `src/tools/{invoices,finance,debtS,sales-report}.ts` (`debts.ts` is lowercase), reporting tests.
Interfaces: keep array-fetch callers compatible; new page envelope accepts value/nextLink and an injected validated continuation callback. `PageScan` adds completeness/stopReason/continuation while retaining capped/pages/rows.

- [x] Write failing fixtures: maxRows 600 returns <=600; no missed next page or nested page; 5,000 reconciled invoices report 0 found; malformed/reversed dates fail before requests; date-only final fractional second included; adaptive reads handle 408 and never retry 501/505.
- [x] Run fixtures and verify the defect failures.
- [x] Implement exact caps, continuation metadata, stable full-key ordering, paged cash/revenue/sales reads, truthful debt guidance and bounded adaptive reporting. Coordinate continuation URL validation with Task 1; do not edit its client file.
- [x] Run relevant tests plus the full suite when stable.
- [x] Primary reviews financial semantics and confirms every partial result is explicit.

### Task 3: Credentials, HTTP sessions and effective identity (B01, B11, B14)

Files: `src/{index,server,config}.ts`, `src/resources/index.ts`, new `src/lib/connection-info.ts`, new HTTP module, `src/lib/http-auth.ts`, new protocol/resource tests.
Interfaces: optional injected shared `PriorityClient` into `createServer`; version helper obtains package version; HTTP start exports a closeable server for tests. Existing stdio entry still works.

- [x] Write failing tests for synthetic PAT never emitted, config precedence, cross-session invalidation, aggregate rate limiting, TTL 30min/cap100, failed init cleanup, bearer/Origin and real initialize/list/call/delete requests.
- [x] Confirm expected failures before implementation.
- [x] Implement sanitized resource identity, bounded session lifecycle, tenant-shared backend client, clean shutdown and actual protocol tests. Keep loopback and bearer checks.
- [x] Run HTTP/resource/config tests and typecheck; no real backend use.
- [x] Primary reviews credential boundaries and session ownership.

### Task 4: Bounded results, capability discovery and workflow descriptions (B05, B09)

Files: `src/lib/write-guard.ts`, new `src/lib/{tool-result,capabilities,tool-registry}.ts`, new `src/tools/capabilities.ts`, `src/tools/index.ts`, `src/prompts/index.ts`, result/capability/protocol tests.
Interfaces: `textResult` remains compatible, adds identical structuredContent, text <=24000 valid JSON. New tools `priority_get_capabilities` and `priority_healthcheck`; catalog entries have mode/implementation/policy/availability/evidence. Registration adds truthful annotations and a compatible object output schema.

- [x] Write failing tests for oversized nested JSON, 102-tool classification, policy filters and all-blocked behavior, no startup I/O, refresh errors not reported as absence, guide readOnly annotations, structured/text equivalence.
- [x] Verify expected failures.
- [x] Implement bounded output and complete catalog; lazy bounded runtime probes with cache; prompts begin with capabilities and avoid mandatory calls to unavailable tools.
- [x] Run result/catalog/protocol tests.
- [x] Review all unavailable domains; keep exact reasons and next evidence source for unsupported operations.

### Task 5: Dependency update, docs, release verification (B02, B13, B15)

Files: `package*.json`, Zod call sites as needed, `.github/workflows/ci.yml`, `README.md`, `CHANGELOG.md`, `docs/{tools,security,deployment}.md`, `.env.example`, Dockerfile if needed, smoke/audit scripts.

- [x] Record baseline audit and current installed versions; update compatible dependencies and perform deliberate Zod 4/Vitest 4 migration.
- [x] Run clean install, all tests, build, lint, stdio and HTTP smoke, audit, packaging checks. Resolve concrete failures, not test weakening.
- [x] Document actual supported/blocked capability counts, safe Docker/auth examples, Node floor, version and upgrade/restart procedure.
- [x] Obtain fresh whole-change review; fix important findings and re-run affected checks.
- [x] Integrate only reviewed files back into the user's starting checkout; preserve unrelated files; build local artifacts. Report local completion separately from live deployment and conditional ERP features.

## Conditional capability expansion

| Group | Tools currently unavailable | Completion requirement |
| --- | --- | --- |
| Debt/payment/AP | Customer/company aging, overdue, payment history, promise/dispute, AR/AP summaries, cash projection, supplier balance | Actual due dates, remaining amounts, reconciliation links and write mappings; otherwise explain missing source |
| CRM | 5 activity/task tools | Verified customer-linked activity/task schema; never write a contact master as an activity |
| Inventory/pricing | Low/out-of-stock, product sales history, stock adjust/transfer, update product price | Warehouse/price-list scope, full stock scan and supported document/procedure path |
| Document lifecycle | Invoice void and order confirm | Supported procedure and explicit authorized test-company round trip |
| Product ranking | Top products | Complete line-level source or verified bounded expansion with completeness metadata |

Local completion means code and tests for detection/fallbacks are finished, not that unsupported Priority procedures become executable. No fabricated implementation is an acceptable substitute for source evidence.
