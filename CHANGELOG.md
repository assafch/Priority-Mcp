# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- Add shared account request scheduling, subscriber-isolated GET coalescing, byte-bounded caches and request-context metrics.
- Correct short-page search coverage, share targeted schema/capability evidence, and provide a compact optional operations profile with detailed help fallback.
- Add exact/ambiguous entity resolution, safe typed read-query previews and three policy-checked read workflows.
- Add scoped bounded result handles, resumable report window contributions and honest multi-observation evidence.
- Add deterministic synthetic evaluation, maintained offline benchmarks and an explicit budgeted read-only pilot tool. Live deployment and host/model performance remain separately unverified.

## [0.2.0] - 2026-10-25

Local software update; live tenant execution and deployment remain separately verified.

- Add capability discovery, optional backend health check, safe subform-row updates, and structured results/annotations for every tool.
- Fix legacy PAT resource exposure, unverified update success, invalid oversized JSON, misleading capped-invoice counts, composite-key gaps, and cross-client discovery/search cache reuse.
- Improve complete report paging, date boundaries, bounded adaptive reads, and accurate missing-source guidance.
- Share the HTTP backend per tenant/configuration; bound sessions and test real protocol/auth/lifecycle behavior.
- Upgrade SDK/Zod/Vitest and transitive dependencies; declare Node 22.13+ and CI on 22/24.
- Replace unsafe operational helper behavior with guarded previews and explicit procedure guidance. Keep 24 unsupported handlers and 5 procedure guides truthful.

## [Unreleased — historical July work]

### Fixed — defects reported from a multi-day live import-file reconciliation (`PRIORITY_MCP_ISSUES.md`)

Every item below was verified against the live ORGAT tenant (company `a051014`,
`tabp008h.ini`, Priority 25.1) on 2026-07-29 — see `scripts/live-verify-issues.mjs`
(50 checks, read-only) and `docs/tenant-forms-cheatsheet.md`.

- **`priority_upload_attachment` re-enabled and implemented** (P0-1). It was hard-disabled;
  it now POSTs to the parent document's attachments sub-form and re-reads it to confirm what
  Priority stored. The sub-form name is **discovered at runtime** from `GetMetadataFor` rather
  than hardcoded — which immediately paid off: `CUSTOMERS` spells it `CUSTEXTFILE_SUBFORM`,
  `LOGPART` uses `PARTEXTFILE_SUBFORM`, and a form with none (e.g. `PARTSTATS`) is reported as
  such along with the sub-forms it does have. `EXTFILENAME` is a **path** into Priority's
  document store (the service declares no media/stream entity), so base64 `fileContent` is
  refused with that explanation instead of creating a row pointing at nothing.
  Proven by a real write round-trip on a draft import file (`scripts/live-verify-attachment.mjs`):
  POST → Priority assigns `EXTFILENUM` → visible via the sub-form and `$expand` → DELETE `204`,
  document left as found. Note for callers: Priority does **not** validate the path on insert
  (a bogus path was stored with `FILESIZE: 0`), and the tool's description says so.
- **`impfile_link_invoice` `line` and `final` routes implemented** (P0-2). They claimed the
  entity was "not yet mapped"; both are mapped now — `line` PATCHes
  `IMPFILEIV(IVNUM,DEBIT,TYPE)/IMPFILEIVS_SUBFORM(KLINE=n).IMPFNUM` (and lists the invoice's
  lines when no `line` is given), `final` targets **`PIVDETAILS`** and, because that form's API
  flag is off on this tenant, probes it at runtime and names it so an admin can enable it.
- **`priority_get_bank_balances` / `priority_get_cash_position` retargeted** (P0-3). They queried
  `BANKACCOUNTS`, which does not exist here (bare `Not found:`). `BANKS`/`CASH`/`BANKPAGES` exist
  but are API-flag-off *and* hold no balances anyway. Balances now come from the GL:
  `ACCOUNTS` filtered `CASHNAME ne ''`, with `BALANCE1/2/3` reported as Priority stores them
  (no sign flipping) and cash totalled per currency.
- **`priority_list_entities` no longer blows the result budget** (P1-1): it used a local
  uncapped `textResult` and returned ~60k chars / 3k lines. It now routes through the shared
  budget and takes `prefix` / `contains` / `limit`.
- **`$metadata` is now parsed in both representations Priority sends** (found while verifying the
  above). The identical request alternates between CSDL **XML** (~10.0MB, `application/xml`) and
  CSDL **JSON** (~7.4MB, `application/json; odata.metadata=minimal`) — the JSON case arrived as a
  parsed object, so the XML regex matched nothing and `priority_list_entities` cheerfully reported
  **0 entity types** instead of ~3015. `src/lib/csdl.ts` handles either shape (`csdlEntityNames` /
  `parseCsdl`), and every metadata consumer goes through it: `priority_list_entities`,
  `priority_get_entity_schema` (which now also returns key/title/sub-forms),
  `priority_get_entity_metadata`, the `priority://schema/{entity}` resource, and attachment
  sub-form detection. A document that is empty or not CSDL is retried once and then raised as an
  error instead of being returned as an empty list.
- **`priority_list_forms` takes `prefix` / `contains` / `limit`** (P1-2). Previously it accepted
  no parameters yet advised narrowing, and truncated at 171 of ~1370 forms. The service document
  (~65s) is memoized in-process for 15 minutes and shared between concurrent callers.
- **A 404 now explains itself** (P1-3). `Not found:` (empty) became three distinct diagnoses —
  absent entity set / composite-key arity / bad key — plus an alias map for the names that get
  tried by mistake (`GLPERIODS`→`ACCDATES`, `LOGCOUNTERS`→`LASTCOUNT`, `WARHSBAL`→`WARHSBALREP`,
  `IMPFILEITEMS`→`IMPFILES/IMPFILEITEMS_SUBFORM`, `CASHACC`/`BANKACCOUNTS`→`ACCOUNTS`, …).
  Errors now carry the form they were about (`PriorityError.resource`).
- **The opaque `$select` XML error gets a hint** (P1-4): *"היתה בעיה ביצירת ה-XML…"* now explains
  that a selected field is not projectable on that form and how to isolate it. A field can be
  filterable but not selectable (verified: `PINVOICES.VATFLAG`), and Priority reports that
  condition with either this message or `Could not find a property named` — both are handled.
- **`readOnly` → `serverReadOnly` in `priority_get_current_user`** (P1-5), with the remediation
  inline (`.env` **and restart the MCP host**), plus the real Priority identity from
  `GetTenantDetails()` / `GetLoginName()`.
- **Screen-procedure tools renamed and marked** (P2-1): `bonded_receipt_create` →
  `bonded_receipt_guide`, `bonded_release_create` → `bonded_release_guide`,
  `bonded_fill_detail` → `bonded_fill_detail_guide`, `bonded_line_costs` →
  `bonded_line_costs_guide`, `impfile_run_calc` → `impfile_run_calc_guide`. All return
  `"mutates": false`.
- **`impfile_close` / `impfile_reopen` verify instead of assuming** (P2-2): after the PATCH they
  re-read the file (cache invalidated first) and report whether `CLOSED='Y'` / `STATDES='סופי'`
  actually took, warning explicitly when a procedure-gated write silently did nothing.

### Added

- **`priority_search_suppliers`** (P2-3) — fuzzy supplier search with the same capability-aware
  fallback as the customer/product searches (`contains()` is HTTP 501 on this installation).
- **`docs/tenant-forms-cheatsheet.md`** (P2-4) — live-probed form map for this tenant: what is
  exposed, what exists with its API flag off, what is absent and what to use instead, plus the
  attachment sub-form names and the installation's quirks.
- **`scripts/live-verify-issues.mjs`** — read-only live verification of every fix above, printing
  the request/response evidence each check was decided on (`--json` to save it).
- **`src/lib/forms.ts`** — form discovery + runtime capability probing (`ok` / `api-flag-off` /
  `absent`), and attachment sub-form detection.
- **`src/lib/form-aliases.ts`** — static map of wrong-name → right-form used by the error path
  (no extra round-trip).
- `PriorityClient.resolveSubformRowUrl` / `getSubformRow` / `updateSubformRow` — address one row
  of a sub-form under a composite-keyed parent.

- **`priority_product_sales_by_period`** (`src/tools/sales-report.ts`) — per-product sales
  quantity/value bucketed by half-month / month / week, in a single call. Works around this
  installation's limits: the flat sales-line forms (`SALESINVOICEITEMS`) are API-blocked and
  OData `any()` is unsupported, so it expands `AINVOICEITEMS_SUBFORM` over the range in
  **adaptive windows** that back off and split on the server's `terminated` timeouts. Merges
  tax invoices (`STATDES='סופית'`, by `IVDATE`) with delivery notes (`DOCUMENTS_D`, by
  `CURDATE`), de-duplicated via each delivery line's billed `IVNUM`; excludes cancelled/draft;
  returns/credits net automatically. Verified against live data (Jun 2026 = 1,632 units).

- **8 generic, form-agnostic building-block tools** (`src/tools/generic.ts`), bringing the
  total to 80 tools:
  - `priority_list_forms` — lists API-exposed entity sets from the OData service root
  - `priority_get_entity_metadata` — `GetMetadataFor(entity='X')` (field names/types/titles/mandatory, Priority 25.0+)
  - `priority_describe_form` — universal `{form}?$top=1` field-discovery fallback
  - `priority_query` — structured `filter`/`select`/`expand`/`orderby`/`top`/`skip`
  - `priority_get_record` — fetch one record by key
  - `priority_create_record` — POST with OData **deep-insert** (header + sub-form line arrays)
  - `priority_update_record` — PATCH fields on a record
  - `priority_add_line` — POST a line to a sub-form (navigation property)
  - All three generic write tools gate on **`confirm`** (default `false`) and return a DRY-RUN
    preview of the exact method + endpoint + JSON body without sending.
- Optional `X-App-Id` / `X-App-Key` per-application licensing headers (`PRIORITY_APP_ID` / `PRIORITY_APP_KEY`).
- `PRIORITY_SERVICE_ROOT` to override the full OData root when the assembled URL doesn't match an install.

### Fixed

- **OData value encoding** — query option *values* are now percent-encoded (spaces, single quotes,
  Hebrew) while keeping `$option` keys literal; dates emit as unquoted ISO 8601; decimals use `.`.
- **Service-root URL** — corrected to `{API_URL}/{ENVIRONMENT}/{COMPANY}` (was producing a doubled
  `/odata/Priority/.../odata/Priority/tabula.ini/...` path); `PRIORITY_ENVIRONMENT` now defaults to `tabula.ini`.
- **`sanitizeODataValue` no longer destroys data** — it previously stripped `'";\/`, mangling values
  like `O'Brien` and `ABC/123`; escaping is now handled correctly by the builder.
- **Allow/block tool lists are now enforced** at registration (were parsed but ignored).
- Error responses now surface the **raw HTTP body** so the model can self-correct; non-JSON
  responses (e.g. `$metadata` XML) no longer crash request parsing.

### Auth

- Documented and clarified the dual auth model: PAT installs (`USERNAME=<token>`, `PASSWORD=PAT`)
  and classic on-prem (`USERNAME`/`PASSWORD`) — both via HTTP Basic.

## [0.1.0] - 2026-04-19

### Added

- Initial release with 72 MCP tools across 12 domains:
  - **Customers** (10 tools) — list, get, search, balance, contacts, price list, documents, aging, create, update
  - **Orders** (9 tools) — list, get, pending, shipment status, backorder report, create, update, cancel, confirm
  - **Products** (11 tools) — list, get, search, stock levels, low stock, out of stock, price, sales history, update price, adjust stock, transfer stock
  - **Invoices** (6 tools) — list, get, unpaid for customer, create, void, credit memo
  - **Debts** (7 tools) — open debts, aging report, overdue invoices, payment history, top debtors, record payment promise, mark disputed
  - **Finance** (8 tools) — bank balances, cash position, revenue by period, top customers, top products, AR aging, AP aging, cashflow projection
  - **Purchase Orders** (4 tools) — list, get, incoming shipments, create
  - **Suppliers** (3 tools) — list, get, balance
  - **Warehouses** (1 tool) — list warehouses
  - **Activities** (5 tools) — list, customer activities, open tasks, create, schedule followup
  - **Documents** (3 tools) — list attachments, get URL, upload
  - **Meta** (5 tools) — list entities, entity schema, list companies, current user, raw OData query
- Stdio and HTTP (Streamable HTTP) transport support
- Read-only mode (`PRIORITY_READ_ONLY=true`)
- Tool allow/block lists for access control
- Response caching with configurable TTL
- Rate limiting
- Custom entity support for Priority customizations
- Docker support with distroless image
