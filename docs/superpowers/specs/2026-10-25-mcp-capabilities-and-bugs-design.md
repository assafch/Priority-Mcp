# Priority MCP capabilities and bug update design

Status: **local implementation and original-checkout integration complete**. Date: 2026-10-25.

Implementation result: [completion report](../../audits/2026-10-25/completion.md). The starting-point tables below preserve the pre-update audit.

## Intent and scope

The initial request was audited as a full update plan. The user subsequently instructed “לעדכן הכל”, authorizing local implementation, dependency updates and verification. The plan has been implemented locally. ERP transactions, tenant-form activation, package publication and remote deployment were not performed.

Repository: `/Users/assaf/Documents/Priority MCP/priority-mcp-server`, baseline commit `4fc5577`. Two pre-existing untracked scripts, `scripts/composite-write.mjs` and `scripts/finalize-docs.mjs`, belong to the current workspace and must be preserved. They are operational helpers, not registered MCP tools.

## Verified starting point

| Measure | Current evidence |
| --- | --- |
| Tools registered | 102 in source and through an offline MCP connection; 102 also exposed to this assistant |
| Code paths | 52 read paths, 21 guarded write paths, 5 instruction-only guides, 24 unconditional unavailable responses |
| Other MCP capabilities | 2 static resources, 1 resource template, 5 prompts |
| Automated tests | 228 passing in 21 files, Node v26.4.0 |
| Type checking and compilation | `npx tsc --noEmit` and isolated-output `tsc` both pass |
| Lint | Full workspace fails with 5 diagnostics in the 2 pre-existing untracked scripts; scoped source/tests/docs lint passes |
| Dependencies | Registry audit reports 19 affected package entries: 3 critical, 11 high, 4 moderate, 1 low; includes development dependencies and conditional code paths |
| MCP metadata | 0 tools expose annotations; 0 expose output schemas |

“Implemented” describes code, not current tenant permissions or proof that a workflow completes. No real tenant requests were made in this audit. Historical July fixes remain historical evidence; they are not reclassified as fresh live verification. Existing `PRIORITY_MCP_ISSUES.md` remains intact.

The complete 102-tool list is in [capabilities](../../audits/2026-10-25/capabilities.md). Reproduction and raw dependency evidence are in [offline-evidence.json](../../audits/2026-10-25/offline-evidence.json), [reproduce.mjs](../../audits/2026-10-25/reproduce.mjs), and [dependency-audit.json](../../audits/2026-10-25/dependency-audit.json).

## Goals and required behavior

1. **Trustworthy results:** do not expose credentials; do not report a write as verified when only an HTTP acknowledgment exists; keep large results valid JSON; expose scan limits and unknown outcomes explicitly.
2. **Useful capability discovery:** publish every tool's implemented mode, form requirements, policy state, and dated evidence. Distinguish code limitations, form API flag off, permissions, absent entities, and procedures requiring the Priority UI.
3. **Complete generic operations:** support validated composite keys and subform row addressing without private-method scripts. Keep existing simple-key callers compatible and all preview/write safeguards intact.
4. **Reliable operation:** improve HTTP lifecycle, tenant-scoped rate limiting and cache consistency, dependencies, protocol tests, and deployment recipes. Treat the existing local web portal as a demo throughout.
5. **Evidence-driven expansion:** map the 24 unavailable tools by domain and implement only capabilities supported by discovered schemas and verified semantics. Each unsupported operation must still provide a specific blocker and evidence source.

## Non-goals and anti-goals

No universal ERP procedure executor, automatic financial finalization, unattended posting, new WhatsApp/Telegram bot, public portal deployment, PDF generation claim, or bank-clearing claim is included. Do not remove safety switches to make a test pass. Do not call a path registration a file-byte upload, an ERP ledger balance a bank-confirmed balance, a receipt a cleared payment, or an order's status customer delivery. Do not implement guessed accounting fields or enable all blocked tools at once.

## Architecture decisions proposed by the author

These are implementation defaults, not preferences explicitly supplied by the user.

### Capability catalog

Add `src/lib/capabilities.ts`, `src/lib/tool-registry.ts`, and `src/tools/capabilities.ts`. The catalog is declarative and has one entry for every registered tool. `priority_get_capabilities` supports `domain`, `includeUnavailable=true`, and `refresh=false`; `priority_healthcheck` performs bounded, read-only backend checks only when requested. Startup and ordinary tool listing must not trigger full `$metadata` downloads. Refresh probes are limited to 4 concurrent reads, cached for 15 minutes, and explicitly dated. Never turn a failed auth/network request into “absent form.”

A capability entry has `name`, `domain`, `mode: read|write|guide`, `implementation: implemented|unavailable`, `access: enabled|blocked`, `availability: available|api-disabled|permission-denied|absent|procedure-only|unknown`, `requiredForms`, `reason`, `checkedAt`, and `evidence: static|offline|live-read|live-write`. Availability cannot be “available” from registration alone. Capability discovery obeys the effective allow/block policy, and policy-blocked entries carry no executable route. Do not automatically unhide a tool following a probe.

Keep existing tools registered by default for compatibility. Unavailable entries return the established `available:false` contract plus reason and provenance. Guides remain visibly non-mutating. Prompts consult capabilities and fall back to working reads; they must not require known-unavailable aging/CRM/payment tools.

### Results and writes

Add `src/lib/tool-result.ts` for a versioned envelope used first by the new tools. Existing tools retain their top-level payload fields and gain consistent `meta`. The common metadata shape is `{schemaVersion:1, source, observedAt, complete, warnings}`; `source` identifies form/company without credentials, and `complete` is `boolean|null` (null means not evaluated). Structured content and JSON text must represent the same bounded result, with a hard **24,000-character text budget** and explicit omission counts. Large objects must never be sliced into invalid JSON.

Write outcomes use `status: preview|blocked|verified|unverified|unknown|failed`, `acknowledged`, `verified`, and `verification` containing expected/observed public fields or a reason. A successful PATCH is not `verified` until an uncached read agrees. A no-op must never return `updated:true` or `cancelled:true`. A timeout or lost write response is `unknown`; do not retry it or represent it as definitively rejected. Preserve additive document identifiers from successful create responses even if verification is incomplete.

### Keys, paging, and data semantics

Retain `key:string` and add `keys:Record<string,string|number>`; require exactly one. Validate key names against metadata/schema, reject empty objects, non-finite numbers, unexpected key fields, and ambiguity. Add safe public composite/subform client methods rather than exposing `send()`. Composite support includes get/update/add-line, existing attachments, and a new `priority_update_line`; no generic delete tool is proposed.

Paginated scans carry `rows`, `pages`, `complete`, `stopReason`, and `nextCursor`. Follow OData next links only after exact origin and normalized company-path checks; reject loops and cross-company URLs. Respect `maxRows` exactly. If next-link semantics are absent, retain Priority's tested skip mode with a stable full-key order and record that mode. An unresolved short server page cannot prove a global total. Aggregates must page cash accounts, invoice headers, and expanded sales data, including nested subform continuation where supplied.

Unreconciled invoice status is not a verified remaining balance or payment date. Keep those fields unknown until an actual reconciled/open-item source supplies them. Totals preserve currency and distinguish ledger, physical stock, source document, and actual payment evidence.

### Runtime and dependency policy

Keep TypeScript/Node and the current stdio plus session-based HTTP architecture. Establish Node **22.13+** as the unified package floor because the bundled portal imports `node:sqlite`; run CI on supported 22 and 24 releases. Validate the existing negotiated MCP protocol before considering any later transport revision; a standards-document date is not permission for a breaking wire change.

Share one backend client per authenticated tenant/configuration within a process, with separate MCP transports per session. Add session TTL (30 minutes idle), max sessions (100), cleanup on failure/close/shutdown, and injection seams for tests. Use aggregate per-tenant API limits. Preserve loopback default and fail-closed non-loopback startup without a bearer token. A remote Docker recipe must set the host and authentication explicitly.

Update patched dependencies in isolated groups. Registry candidates observed on 2026-10-25: SDK 1.32.2, Hono 4.13.14, node adapter 1.19.17, undici 7.30.1. Zod 4.6.7 and Vitest 4.1.12 require deliberate major-version migrations and compatibility tests. These are candidates to recheck before implementation, not installation commands already run. Keep TypeScript 5.9.3, Biome 1.9.4, and Pino 9.14.0 unless a concrete blocker requires a change. Examine reachability of every advisory; do not equate package presence with an exploited vulnerability.

## Acceptance and release boundary

Every confirmed finding gets a failing regression before a code change. All current tests continue passing, protocol tests cover tools/resources/prompts and both transports, and CI validates a clean dependency install. All 102 existing tool names remain accounted for; newly added names are explicit. Every unavailable tool gets a truthful supported fallback or named blocker.

Release requires a versioned build, fresh read-only tenant evidence for claimed live reads, and separately authorized test-company writes for any new mutation claim. Rollback restores the previous software/configuration; it does not reverse ERP transactions. ERP data repair is its own explicit operation.

Core software work is estimated at **48–72 engineering hours**, excluding waiting for tenant access. Discovery for conditional domains is **8–16 hours**; implementation estimates for those domains are made only after schema and procedure evidence. A complete plan can be delivered now even when those operational permissions are not available.
