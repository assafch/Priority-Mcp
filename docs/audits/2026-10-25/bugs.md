# Priority MCP bug and gap register — 2026-10-25

**Historical baseline register. Local fixes and verification are recorded in [completion.md](completion.md).** P0 is an immediate release blocker; P1 affects correctness or required capability; P2 is reliability/documentation work. Severity is an engineering assessment. “Reproduced” below means synthetic offline evidence, not production impact.

## P0 — credentials and unsafe operational helpers

| ID | Finding and proof | Required resolution |
| --- | --- | --- |
| B01 | **Reproduced:** `priority://user/profile` returns `config.priorityUsername` (`src/resources/index.ts:91`). In the documented legacy PAT login, username is the credential. The offline resource returned the synthetic PAT sentinel. Actual live credential exposure was not tested. | Never serialize configuration credentials. Return explicit auth mode and separately obtained identity, or identity unknown; test legacy PAT, dedicated PAT, classic auth, precedence, resources, tools, errors, and logs. |
| B02 | **Registry-confirmed dependency exposure:** `dependency-audit.json` has 19 affected package entries, including 3 critical. This is not evidence that all advisory paths are reachable. SDK input validation and Zod collection validation warrant priority; OAuth-client, Windows-only, and development-server cases need separate reachability classification. | Patch compatible packages first; migrate Zod/Vitest deliberately; inspect production versus dev paths; regenerate lockfile in an isolated checkout and rerun audit and protocol tests. No `npm audit fix --force`. |
| B03 | **Source-confirmed local helper hazard:** both pre-existing untracked operational scripts set `cfg.priorityReadOnly=false`; their execution paths can write without preview. They are outside MCP registration and its tool controls. `npm run lint` also reports 5 diagnostics in these files. Neither was executed. | Preserve originals. Introduce a guarded, explicit-confirm CLI or retire these paths after reviewing dependents. Default preview, honor read-only, verify writes, no implicit production finalization. New generic composite tools should remove their routine necessity. |

## P1 — truthful results and document operations

| ID | Finding and proof | Required resolution |
| --- | --- | --- |
| B04 | **Reproduced:** generic update returns `updated:true` when mock response still has `PHONE:'old'`; cancellation returns `cancelled:true` with `BOOLCLOSED:''` (`generic.ts:314`, `orders.ts:254`). No uncached verification follows. | Shared write verification. Distinguish HTTP acknowledgment, actual field change, no-op, readback failure, and unknown commit. Apply to generic/customer/order/import updates; keep existing import close checks. |
| B05 | **Reproduced:** an oversized nested object produces 24,093 characters and invalid JSON because `textResult` slices serialized text (`write-guard.ts:160`). | Valid JSON at or below 24,000 characters, deterministic omission metadata, consistent structured/text results. Preserve identifiers and aggregate metadata where feasible. |
| B06 | **Reproduced:** unpaid-invoice scan over 5,000 fully reconciled fixture rows returns `count:0` but says “found at least 100 open” (`invoices.ts:189`). | Report actual scanned/found/returned counts, `complete:false`, exact stop reason and continuation. Do not label original invoice amount as remaining debt. |
| B07 | **Mixed evidence:** `fetchAllPages({pageSize:500,maxRows:600})` returns 1,000 rows in a fixture; a 100-row response requested as 500 is treated as exhausted. `PriorityClient.list` does not model next links; revenue/cash/sales paths lack complete continuation handling. Actual tenant server pagination limits were not tested. | Enforce exact row caps; support safe next links and stable full-key ordering; distinguish incomplete scans. Handle nested continuation or mark expanded line totals incomplete. Page the 200-account cash total. |
| B08 | **Source/schema-confirmed gap:** generic get/update/add-line expose only `key:string`, although client composite helpers exist. Attachments reject some composite parents; attachment lookup has no equivalent early composite check. | Add validated `keys` to generic and attachment contracts, plus `priority_update_line`; support simple keys unchanged. Reject incomplete/ambiguous composite keys before sending. |
| B09 | **Protocol/source-confirmed capability mismatch:** 24 registered handlers always return unavailable, while descriptions and 5 prompts often imply executable workflows. All 102 tools lack annotations/output schemas. | Capability catalog and machine-readable output metadata; truthful descriptions and prompts; retain existing names. Lack of optional annotations/output schemas is an interoperability improvement, not itself a protocol violation. |
| B10 | **Source-confirmed wrong guidance:** aging/cash-flow fallback text still calls `OPENINVOICES` the A/R source, while corrected `priority_get_open_debts` uses `OBLIGO` and identifies `OPENINVOICES` as uninvoiced delivery documents (`debts.ts:84,107`; `finance.ts:262,302`). | Use consistent authoritative-source descriptions and capability-based fallbacks. Do not infer payment dates, due dates, or remaining invoice balances from unsupported fields. |

## P2 — runtime, reports, documentation

| ID | Finding and proof | Required resolution |
| --- | --- | --- |
| B11 | **Source-confirmed runtime gap:** every HTTP session creates a new `PriorityClient`, each with its own rate limiter/cache (`index.ts:144`, `server.ts:15`). Sessions remain in a map without TTL/cap. Cross-session writes do not invalidate another client's cache. No load/leak production test performed. | Shared backend per tenant/auth scope; separate transports; session TTL/cap and lifecycle cleanup; actual HTTP integration tests, aggregate rate-limit and cross-session freshness tests. |
| B12 | **Source-confirmed timeout mismatch:** client turns timeout into `PriorityError(408)`, but sales-report `isTransient` accepts only 429/5xx for PriorityError, so the documented adaptive-window path skips client-generated timeouts (`sales-report.ts:66`, `priority-client.ts:279`). Report retries also have no overall work deadline. | Treat read timeout as a splittable window failure; deterministic 501/505 never enter long retry loops; add overall deadline/cancellation and explicit missing windows. |
| B13 | **Source-confirmed docs drift:** README says read-only default false; actual config defaults true. Security docs claim allow/block cannot combine and Docker binds all interfaces; both contradict current code. Deployment recipes duplicate the `.ini` path and omit required host/token settings for remote operation. | Rewrite from tested config examples, add container/protocol smoke, and document policy precedence plus precise auth/read-only semantics. |
| B14 | **Source-confirmed identity/version drift:** server version is hardcoded `0.1.0`; static resources use `priorityCompany/environment/apiUrl` fields even when service-root/base-URL config supplies the effective connection. | One release-version source; sanitized effective connection helper; mark backend identity versus config identity, and unknown values explicitly. No credential-bearing URLs in resources. |
| B15 | **Coverage gap:** HTTP tests cover helper predicates but not the real listener/session lifecycle; CI does not run stdio smoke; package claims Node >=22.0 while bundled portal requires 22.13+. | Add protocol end-to-end tests and clean-install CI matrix on supported 22/24, adjust package floor, include SDK compatibility and packaging checks. |
| B16 | **Validation gap:** report dates are permissive strings and date helpers pass malformed inputs through; date-only upper bounds end at `23:59:59Z`, excluding fractional timestamps in that final second if present. No current tenant discrepancy demonstrated. | Validate calendar dates/range order before requests, use half-open next-day boundaries for date-only ranges, retain explicit-offset meaning, pin timezone/bucket contract in tests. |

## Reproduction and evidence boundaries

Historical reproduction: compile baseline commit `4fc5577` in a separate checkout, copy this audit script into that checkout, and run from its root. Do not overwrite the preserved baseline JSON with updated-code results:

```sh
npx tsc --outDir node_modules/.cache/priority-audit-2026-10-25
node docs/audits/2026-10-25/reproduce.mjs
```

The script blocks `fetch`, uses only synthetic credentials, writes audit JSON and the inventory, and calls fake write handlers without network access. It does not modify `src`, `.env`, the live `dist`, or ERP data. Its results demonstrate the baseline defects; it is an audit artifact, not a regression suite to preserve bug behavior after fixes.

Baseline verification: 228/228 tests pass, type check and isolated compilation pass. Full lint fails only in the 2 pre-existing untracked scripts at the time of the baseline check. Historical `PRIORITY_MCP_ISSUES.md` records July fixes and operational limits; it is not overwritten by this register.

## Source references checked on 2026-10-25

MCP supports structured tool output and optional output schemas; metadata hints do not replace permission checks. See [MCP tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools) and [annotations guidance](https://blog.modelcontextprotocol.io/posts/2026-03-16-tool-annotations/).

The registry flags affected SDK validation and Zod collection-validation versions. See [SDK advisory](https://github.com/advisories/GHSA-46jr-4wx8-v453), [Zod advisory](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5), and [official SDK releases](https://github.com/modelcontextprotocol/typescript-sdk/releases). See the saved JSON for all package entries and conditional advisories; no exploitation testing was performed.
