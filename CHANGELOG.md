# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

- **Action needed on an existing installation:** the bonded warehouse code is no longer written in the source. Set `PRIORITY_BONDED_WAREHOUSE` to your bonded warehouse's `WARHSNAME` before starting this version; without it the import-file tools look for a warehouse named `BONDED` and refuse. `PRIORITY_RELEASE_WAREHOUSE` (default `Main`) is the default target of a bonded release. Both are read once at start (`src/lib/site-codes.ts`).
- README: the front page now has "Import files, end to end" — a diagram of the twelve official steps with the tool that runs each one, a step / tool / Priority program / pilot table, the safety model and the approval-code rule. The tool count is corrected to 126 and the in-page navigation links work.
- Import files: four approval tools for the steps that cannot be undone. `bonded_receipt_finalize` (4b, receipt final), `impfile_close_run` (7, program "סגירת התיק", IMPFILE1), `bonded_release_finalize` (10, release final) and `costing_run` (11, program "תמחיר לתאריך נוכחי", FNCCOSTINGPART, company-wide). Each previews by default and issues an approval code: 10 minutes, single use, bound to the tool, the document and a fingerprint of what the preview showed. A real run needs that code and spends it only right before its one write or program; the code is passed only after the owner approved the preview in chat.
- Receipt and release final are one PATCH of `STATDES`, verified by re-reading the status and the stock (`BONDED/0` and the target warehouse). The stage lock has one more narrow opening, used only by `bonded_release_finalize`: a header PATCH of exactly `{STATDES: 'סופית'}` on `DOCUMENTS_J`.
- `impfile_close_run` refuses unless the newest loading calculation ran through `impfile_run_calc` and nothing changed the file after it (the `impfile_*` writes now record a file change). `costing_run` answers only its one known question; `done` needs `COSTINGLOG` to move, no file still pending and an end without an error.
- The four approval tools have not yet run against real data: results carry `"piloted": false`.
- Import files, the "מע'מ" (VAT-from-declaration) line: `bonded_fill_detail` now deletes the line FILL_IMPFILES copies into the file content instead of zeroing it; a zeroed line stayed in the content and Priority pulled it into the release (the first pilot file and its release, 2026-11-23). If Priority refuses the delete, the line is zeroed as before and a warning says so. A "מע'מ" line with quantity 0 on a release is ignored, with a warning, by `bonded_release_draft`, `bonded_line_costs`, `bonded_line_costs_guide` and the release facts the reports read; one with a quantity still stops the release. `bonded_line_costs_guide` reads the file and the releases live: right after "רישום עלויות יבוא לשורה" it showed a cached `linesWithoutCost: 1`.
- `bonded_receipt`, `bonded_fill_detail`, `impfile_run_calc`, `bonded_release_draft` and `bonded_line_costs` are marked piloted (first pilot file, 2026-11-23; runbook table). The VAT-line delete and the release's VAT-line handling have not yet run live.
- Import files: six executing tools for the reversible steps of Priority's official procedure. `pinvoice_set_declaration` (import declaration on every product line of a draft goods invoice), `bonded_receipt` (draft receipt into `BONDED` with the invoice quantities), `bonded_fill_detail` (program "מילוי פירוט למחסן ערובה", then zeroing the VAT line it copies), `impfile_run_calc` (program "חישוב העמסה"), `bonded_release_draft` (draft release, whole balance or a partial list) and `bonded_line_costs` (program "רישום עלויות יבוא לשורה" on the draft release, returning the cost of every line). Each previews by default, reads before it writes, refuses when an earlier step is not proven or could not be read, changes nothing on a repeat, continues a half-made draft instead of creating a second one, and reports done only from a re-read. None writes a document status: making the receipt and the release final, closing invoices and the file, and the costing stay with the owner.
- The three programs run through the Web SDK as a direct activation of the row, once, never retried. An input dialog or an unlisted warning cancels the run and is returned to the caller; after a run whose result is not confirmed the same step waits 180 s. Every attempt is appended to `output/import-step-attempts.jsonl`.
- The release lock has one narrow opening, used only by `bonded_release_draft`: a draft header with seven listed fields and line quantities. A status, a flag, a cost row, a new line, a delete, and every other caller stay blocked.
- `impfile_preflight.official.nextAction` now names who does each step; the bonded guides and `impfile_run_calc_guide` point to the executing tools and say what stays with the owner. `impfile_close` and `impfile_preflight` show `lastCalcViaTool`.
- Safety details of the six tools: a create that gets no answer is `unverified` (never "no document"); a claim file allows one caller per step and file on a machine, and existence is re-read right before a create; a draft with quantities other than the requested ones is not overwritten; a program that ended with a message, a cancel Priority did not confirm, per-line costs that do not tie to the cost invoices and a rerun that changed nothing are `unverified`; every VAT line in the content is zeroed, not only the first. The six tools run under a three-minute budget per call. `output/import-step-attempts.jsonl` and `output/import-step-claims/` are git-ignored.
- Not yet run against real data: results carry `"piloted": false`, and `docs/impfiles-runbook.md` has the pilot protocol for the first supervised run of each tool.
- Add `scripts/start.mjs`, a start that survives a wiped `dist`: it installs from the lockfile when dependencies are missing, builds when `dist/index.js` is missing or older than the source, then loads the server in the same process. It writes only to stderr (stdout is the MCP stdio stream), refuses to start on a failed build rather than run old code, and makes concurrent starts wait for a single build. `npm start` now runs it.
- Import files now follow Priority's own procedures, read in full: SOP "תיקי יבוא" (LBI2400273) and "עבודה עם מחסן ערובה" (LBI2400656). `impfile_preflight` returns `official`: the twelve steps from opening the file to the landed cost per product, each with its SOP clause and Priority program, the first step not yet done, and `violations` (things done in an order the SOP does not allow). A step whose data cannot be read is `unknown`, never done.
- Add `impfile_cost_report` (read-only): landed cost per product of one import file from Priority's own figures — the per-line cost screen ("עלויות יבוא לשורה"), the cost Priority recorded on the stock entry, and the product's cost and costing date. Reconciles the import costs on the final releases against the file's cost invoices without the VAT-from-declaration line, to the agora (a difference within half an agora per released line is reported as allocation rounding).
- Add `impfile_costing_readiness` (read-only): the costing program runs on every part in the company, so this scans all releases — final releases without line costs or on an open file block; files changed after the last costing run are listed as pending.
- Correct the order stated by the stage lock and the bonded guides: per the SOP, "רישום עלויות יבוא לשורה" runs on the release while it is still a draft and the file is closed, and the release is made final afterwards. Every run on this tenant so far was on a final document; the guides say so.
- Import-file stage lock. The server now refuses, on every write path (curated tools, generic tools, scripts that import the client), a field write of an import file's status (`IMPFILES.CLOSED` / `STATDES`) and any write to a bonded release (`DOCUMENTS_J`, header or lines). Closing, reopening and releasing are screen procedures with a mandatory order (receipt into BONDED → detail → loading calc → close → release → per-line costs → costing). Opening a draft file and ordinary header edits are unaffected.
- `impfile_close` and `impfile_reopen` no longer write. They report which steps of the mandatory order are proven (invoices final, final receipt into BONDED, detail filled, customs estimate covers the content, release) and the next step; a document read that fails counts as unknown and blocks. `dryRun` / `override` are still accepted and ignored. `impfile_update` and `impfile_open` no longer take `status`; a file is always opened as a draft. `impfile_preflight` includes the same stage and is not `ok` while a step is missing.
- Bonded guides: removed the wrong statement that bonded steps cannot be written over OData; each guide now names who does the step and the exact screen action. `bonded_release_guide` lists what is missing before a release. `bonded_line_costs_guide` reads back every release of the file and counts released lines without a per-line import cost.
- Fix `pinvoice_create` doubling goods lines when a purchase order is given. Priority copies the order's lines into the invoice once `ORDNAME` is on the header, so sending them too left every line twice and doubled the total. The header is now sent alone; the pulled lines are set to the invoice quantity/price, order lines not on the invoice are deleted, and the draft is read back (line count, order link per line, total). Charges printed on the supplier's invoice that are not on the order (carriage, pallets) go in the new `extraLines` and are added as manual lines. It refuses before writing when a part is not on exactly one open order line or the supplier already has an invoice with that number, and its description states that the invoice number is the supplier's invoice number, not a sales-order number. Verified live on a test draft 15.11.2026 (header-only pull, line PATCH, manual line POST, read-back).
- Add `priority_delete_line`: delete one identified sub-form row from a draft document. Preview by default, `confirm` to run, refused on final/journalled/cancelled/closed documents, verified by re-read (row gone, count minus one). Verified live 15.11.2026 on an invoice line and an attachment row. A whole draft invoice cannot be deleted over OData: Priority requires its own "מחיקת חשבונית זמנית" action.
- Fix `priority_update_line` failing every confirmed call with HTTP 500 "entity …_SUBFORM not found: parse metadata … XML decode: EOF": it asked Priority for the sub-form's metadata as if it were an entity. Row keys are now validated against the row type declared on the parent form.
- `priority_upload_attachment` can attach a file the caller holds: `localPath` (a file on the server's machine) or base64 `fileContent` is sent as a data URI in `EXTFILENAME` (10 MB limit, type and magic-byte checks) and verified by hashing the bytes Priority stored. Attachment listings no longer echo inline file content. Verified live 15.11.2026 (upload, hash read-back, row delete).
- Add `priority_print_document`: the official Priority print layout (WWWSHOWORDER, WWWSHOWAIV, WWWSHOWEIV, WWWSHOWCIV, WWWSHOWTIV, WWWSHOWDOC) as a PDF via the Web SDK. Display mode only — it does not finalize drafts, set the Printed flag, or email the customer. Returns base64 for a remote MCP client.
- Add `priority_close_invoice`: finalize an invoice draft with Priority's own CLOSEANINVOICE activation through the Web SDK (full identity required, OData preflight, dry-run default, no retries, OData verification, attempt ledger).
- Refuse any OData write that carries the procedure-only field FINAL (body at any depth, any spelling, or as the URL target) in the client and in every raw-field tool; a direct FINAL write locks a draft with no journal (T9037, T9308 — ticket SCI00000000).
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

Every item below was verified against the live reference tenant (company `demo`,
`tabula.ini`, Priority 25.1) on 2026-07-29 — see `scripts/live-verify-issues.mjs`
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
  returns/credits net automatically. Verified against live data.

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
