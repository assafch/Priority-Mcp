# Import-File (תיק יבוא) MCP Toolset — Design

**Date:** 2026-06-26
**Status:** Approved design → implementation plan next
**Source of truth:** SOP `SOP_ShipVouch_23_1_H.pdf` ("תיקי יבוא", Priority Cat. LBI2400273) + project `SOP_תיקי_יבוא.md` (3-document model) + live probe of company `a051014` + Priority SDK (`PrioritySDK.pdf`).

---

## 1. Goal

Give Claude (via the Priority MCP server) **top-down support for the full import-file accounting process**: one-time setup audit → open file → link the three incoming documents → manual loading split → customs/loading preview → close-readiness gating. An import file links **landing costs** (freight, insurance, customs, brokerage) to the **purchase invoices** of a shipment so costing loads those costs onto product cost. A wrong product cost ⇒ wrong sale price and margin; the toolset's job is to make every file **complete and balanced before costing runs**.

The "3 incoming documents" model (from the existing SOP) is the spine:

| # | Document | Carries | Priority target |
|---|----------|---------|-----------------|
| 1 | Supplier invoice (חשבונית ספק) | SKUs, qty, price, Incoterms, currency | purchase invoice linked to file (`PINVOICES.IMPFNUM`) |
| 2 | Forwarder/customs-broker invoice | freight, insurance, brokerage, port fees | central supplier invoice w/ cost items, linked to file |
| 3 | Customs declaration (רישומון) | declaration no., duty, purchase tax, import-VAT, FX | `IMPFILES.CUSTOMSNUM`/`CUSTOMSDATE`; import-VAT invoice |

Principle: **doc 1 = what we bought · doc 2 = what it cost to bring · doc 3 = what we paid the state.** A valid file needs all three.

---

## 2. Hard constraints (discovered, non-negotiable)

These reshape the design and are why the toolset is **capability-aware**.

**C1 — Compute actions are not REST-callable.** Priority's `netprest` OData provider exposes pure entity CRUD only (`priority_get_entity_metadata` returns `fields` + `subforms`, never `actions`/function-imports; the service doc lists only `EntitySet`s). Therefore **חישוב העמסה (loading calc) and סגירת התיק (close)** — and PO-line population — **cannot be triggered via the API on any instance.** They remain manual clicks in Priority. (SDK corroborates: REST drives Priority only through form-load/"Direct Activation" record writes that fire field/form triggers; a standalone procedure-button has no REST verb unless separately exposed as an activation link, which this instance does not do.)

**C2 — Core forms are not API-enabled on this instance.** `IMPFILES`, `FNCCONST` (holds constants `ImpFileQuant`/`ImpFileDates`), and `DOCSTATUSES` (statuses) are **metadata-visible but data-blocked**: a record query returns `400 — לא ניתן להפעיל API למסך זה`. They unlock only when a Priority admin ticks "Available for API"/"ניתן להפעלה ב‑API" on each form. Reachable today: `PINVOICES`, `FNCPART`, `COUNTRIES`, `CUSTOMSITEMS`, `LOGPART`, `PART`.

**Design consequence — capability-aware tools.** Every tool first probes whether its backing form is API-enabled. Enabled ⇒ do the read/write (writes are **dryRun-default + confirm**). Blocked ⇒ return the **exact manual step** (form, field, value) instead of erroring. One tool emits the precise **enablement list**. Read-side tools that need IMPFILES data are designed to derive what they can from the **reachable** side (e.g. file→invoice linkage is read from `PINVOICES.IMPFNUM`, which works even while `IMPFILES` is blocked).

---

## 3. Confirmed schema map (live)

> Field names below are the OData column names; Hebrew titles in parentheses. "BLOCKED" = data query refused (C2).

- **IMPFILES** — תיקי יבוא · key `IMPFNUM` · **BLOCKED for data**, metadata OK.
  Scalars: `CURDATE`(ת.פתיחה) `STATDES`(סטטוס) `CLOSED`(סגור) `OWNERLOGIN` `CUSTOMSNUM`+`CUSTOMSDATE`(הצהרת יבוא) `SUPNAME/SUPDES`(ספק) `SUPNAME2/SUPDES2`(שילוח/עמילות) `CODE`(מטבע) `IMPTERMNAME`(תנאי יבוא) `ORDNAME`(הזמנה) `SHIPPERNAME/SHIPPERDES` `IMPORTERNAME` `SHIPCONTNAME` `LOADDOCNUM/LOADDOCDATE`(שטר מטען) `PORTNAME/TOPORTNAME` `EXITDATE/ENTRYDATE` `WARHSNAME`(מחסן ערובה) `NUMOFCONTAINERS` `TOTVOLUME/VUNITNAME`.
  Subforms: `IMPFILEINV_SUBFORM`(linked invoices) `MANIVPARTS2_SUBFORM`+`MANIVDUTIES_SUBFORM`(manual loading) `IMPFILECUSTOMS_SUBFORM`(customs estimate/אומדן מכס) `IMPFILEPORDI_SUBFORM`(linked PO items) `IMPFILEITEMS_SUBFORM`(all file items) `EXTFILES_SUBFORM`+`LIBRARY_SUBFORM`(נספחים) `DOCTODOLIST_SUBFORM`+`DOCTODOLISTLOG_SUBFORM`(checklist/log) `CONTAINERSPLANIMP_SUBFORM` `GENCUSTNOTES_SUBFORM` `IMPFILESTEXT_SUBFORM`.
- **PINVOICES** — central supplier invoices · key `IVNUM,DEBIT,IVTYPE` · reachable.
  Linkage: **`IMPFNUM`**(תיק יבוא/יצוא) **`OTYPE`**(סוג תיק; `'P'`=import) · `CODE`(מטבע) `BOOKNUM` `ORDNAME` `SUPNAME`. Lines `PINVOICEITEMS_SUBFORM` (carries per-line loading ratio); PO link `PIVORDI_SUBFORM`.
- **"חשבוניות לתיקי יבוא" (ex-post link form)** — NOT a standalone entity; it is **`IMPFILEINV_SUBFORM`** on IMPFILES. Manual loading via `MANIVPARTS2_SUBFORM`/`MANIVDUTIES_SUBFORM`.
- **FNCPART** — הגדרות כספים למוצרים · key `PART` (also `PARTNAME`) · reachable. Inline import fields: `DUTYTYPE`(אופן העמסה) `WEIGHT/WUNITNAME/MAINWEIGHT` `VOLUME/UNITNAME` `LENGTH/WIDTH/HEIGHT` `CUSTOMSITEMNAME`(פריט מכס) **`DUTYPERCENT`**(יבוא אוויר %) **`DUTYPERCENT1`**(ים %) **`DUTYPERCENT2`**(יבשה %) **`DUTYPERCENTTYPE`**(סוג עלות יבוא L/S/A) `COUNTRYNAME`(ארץ מקור) `PURTAXCODE/PURTAXPERCENT`.
- **COUNTRIES** — ארצות · key `COUNTRYNAME` · `CUSTOMSTYPE`(סווג למכס) · reachable.
- **CUSTOMSITEMS** — פריטי מכס · key `CUSTOMSITEMNAME` · `PERCENT`(% כללי) `PERCENT1`(קהילה) `PERCENT2`(צפ"א) `PURTAXPERCENT`(מס קנייה) `PURTAXADD` · subform `CUSTOMSCOUNTRY_SUBFORM`(per-country rates) · reachable.
- **FNCCONST** — קבועי כספים · key `NAME` · holds `ImpFileQuant`,`ImpFileDates` · **BLOCKED**.
- **DOCSTATUSES** — statuses · filter `STATUSTYPE eq 'IMPFILES'` · **BLOCKED**.
- **LOGPART** — כרטיס פריט · key `PARTNAME` · `TYPE`(P/R/**O**) `PRICE`(עלות תקן) `FOBPRICE` `PURPRICE/PURCODE` · weight/volume live on **FNCPART**, not here.

Not found (do not use): `CUSTOMSPART`, `IMPFILEINVOICES`, `IMPFILEINV`, `PARTFNC`, `PARTML`, `IMPFSTATUSES`.

---

## 4. Architecture

New module **`src/tools/import-files.ts`** registered via `registerImportFileTools(server, client, config)` in `src/tools/index.ts`. Supporting libs:

- **`src/lib/import-schema.ts`** — frozen constants: entity names, key fields, the field maps above, the loading-method enum (`DUTYTYPE`), and the `OTYPE='P'` import marker. Single source of truth so tools never hard-code strings inline.
- **`src/lib/capability.ts`** — `async function probeForm(client, entity): Promise<'enabled'|'blocked'|'absent'>`. Issues a light `{entity}?$top=1&$select=<key>` (cached). Maps the Hebrew "לא ניתן להפעיל API" body → `blocked`, 404 → `absent`. Used by every capability-aware tool. Plus `guidedStep(form, steps[])` → standard "do this in the UI" result shape.
- **`src/lib/loading-preview.ts`** — pure functions computing the **independent loading-split preview** (basis = weight `WEIGHT`, volume `VOLUME`, or price, selected per `DUTYTYPE`/`DUTYPERCENTTYPE`) and the **customs estimate** (line value × `CUSTOMSITEMS` percent by origin country). No I/O; unit-tested in isolation.

Conventions reused from the existing codebase: `ODataBuilder`, `dateFrom/dateTo`, `escapeODataString/sanitizeODataValue`, `textResult`, `checkWriteAllowed`/`dryRunResult` (writes), `unavailableHere` (absent forms), `toMcpError`. Writes honor `PRIORITY_READ_ONLY` and default `dryRun=true`/`confirm=false`.

**Shared result envelope** for capability-aware tools:
```
{ stage, importFile?, status: 'done'|'dryRun'|'guided'|'blocked',
  data?, preview?, guidance?: {form, steps[]}, warnings[], next? }
```

---

## 5. Tools (by SOP stage)

### 5.0 Discovery / health
1. **`priority_import_api_enablement_report`** — probes every import-file form via `probeForm`; returns which are `enabled`/`blocked`/`absent` and the **exact list to tick "Available for API"** (IMPFILES, FNCCONST, DOCSTATUSES at minimum) to unlock full automation. No inputs.
2. **`priority_import_setup_audit`** — the one-time infrastructure checklist computed from reachable forms: landing-cost items exist (`LOGPART.TYPE='O'`, not stock-managed) with `FNCPART.DUTYTYPE` set; purchased SKUs have `WEIGHT`/`VOLUME` matching their loading method; import-cost standards present (`DUTYPERCENT*`); customs wiring (`COUNTRIES.CUSTOMSTYPE`, `CUSTOMSITEMS` percents, `FNCPART.CUSTOMSITEMNAME`); VAT-from-declaration + constants flagged `unknown` when `FNCCONST` blocked. Input: optional `products[]` to scope. Output: per-check `pass|fail|unknown` + fix hint.

### 5.1 Stage A — open file (write; capability-aware)
3. **`priority_open_import_file`** — create `IMPFILES` (fields: `CODE` currency, `SUPNAME`, `SUPNAME2` forwarder, `IMPTERMNAME` Incoterms, `ORDNAME` PO, `CUSTOMSNUM`/`CUSTOMSDATE`, `STATDES`). dryRun preview of the exact POST; if `IMPFILES` blocked → `guided` with field-by-field steps.
4. **`priority_import_populate_from_po`** — emulates "עדכון שורות הזמנות רכש". Action not REST-callable (C1) ⇒ always `guided` (open file → run action), **plus** reads the PO lines (`ORDERITEMS`/reachable) to preview what should populate.

### 5.2 Stage B — link invoices + manual loading (write/read)
5. **`priority_link_invoice_to_import_file`** — set `PINVOICES.IMPFNUM` + `OTYPE='P'` (and origin-country/declaration fields) on a supplier invoice. **Reachable today.** dryRun PATCH preview → confirm.
6. **`priority_set_manual_loading`** — write `MANIVPARTS2_SUBFORM` lines (per-item loading ratio) on the file. Capability-aware (blocked → guided).
7. **`priority_import_file_linked_docs`** — READ the 3-document picture for a file **without needing IMPFILES**: query `PINVOICES?$filter=IMPFNUM eq '<file>'` (reachable) to list linked invoices, classify each as goods (doc 1) vs cost/forwarder (doc 2) by line content, and report declaration presence (doc 3) from invoice fields. Core input to validations.

### 5.3 Stage C/D — customs estimate + loading calc (guided + preview)
8. **`priority_import_customs_estimate`** — if `IMPFILECUSTOMS_SUBFORM` readable, return it; else compute an **independent** estimate from `CUSTOMSITEMS` percents × line values by origin country (`loading-preview.ts`). Output flagged as preview vs live.
9. **`priority_run_loading_calc`** — wraps "חישוב העמסה": `guided` step **+** independent loading-split preview (weight/volume/price basis from `FNCPART`) so the user can verify Priority's output.

### 5.4 Validation / gates (read; highest value, buildable now)
10. **`priority_import_file_completeness`** — 3-document completeness: doc1 supplier invoice linked, doc2 forwarder/cost invoice linked, doc3 declaration present (`CUSTOMSNUM`). Built on tool #7. Returns missing docs.
11. **`priority_import_three_way_match`** — PO ↔ supplier invoice match on qty/price/currency/Incoterms; lists discrepancies and tolerance breaches.
12. **`priority_import_close_readiness`** — the "no-close-without" gate: all 3 docs linked · declaration present · bonded-warehouse (`WARHSNAME`) items closed · FX basis (`ImpFileDates`) set · loading calc evidently run. Returns ordered blockers; green = safe to close.
13. **`priority_import_stuck_drafts`** — drafts older than `N` days needing attention. Uses IMPFILES if enabled; else derives candidate files from `PINVOICES.IMPFNUM` distinct values with a guidance note about the IMPFILES blackout.

### 5.5 Stage E — close (guided + gate)
14. **`priority_close_import_file`** — runs #12 first; if blockers, returns them and refuses. If clean, returns the `guided` close step (C1) — never writes `CLOSED`/`STATDES` directly (rejected as risky in design review).

### 5.6 Orchestration
15. **MCP prompt `import_file_workflow`** (in `src/prompts/`) — a top-down playbook: given a file (or "new"), it sequences the tools above and tells the user the next concrete step, threading completeness → match → loading → close-readiness.

---

## 6. Error handling & testing

- All tools wrap in `try/catch → toMcpError`. Capability probes are cached per request to avoid re-hitting throttle. Heavy reads always use `$select`+small `$top` (the instance throttles broad/expanded queries — see the sales-report tool's adaptive-window precedent).
- **Unit tests (vitest, no live API):** `loading-preview.ts` math (weight/volume/price splits sum to 100%, edge cases: zero weight, mixed basis, single line); capability-result mapping (Hebrew-blocked body → `blocked`, 404 → `absent`); completeness/close-readiness reducers over fixture linked-doc sets. Mirror existing `tests/*.test.ts` style.
- **Manual live check:** `import_api_enablement_report` + `import_file_linked_docs` against a real `IMPFNUM` (read-only), documented in the plan.

## 7. File layout
```
src/lib/import-schema.ts        # entity/field constants (frozen)
src/lib/capability.ts           # probeForm + guidedStep
src/lib/loading-preview.ts      # pure preview math
src/tools/import-files.ts       # the 14 tools + registration
src/prompts/import-file.ts      # the workflow prompt (wire into prompts/index.ts)
tests/loading-preview.test.ts
tests/capability.test.ts
tests/import-validation.test.ts
docs/ + CHANGELOG.md            # document the suite
```

## 8. Out of scope (YAGNI)
- No writes to `FNCCONST`/`DOCSTATUSES` (blocked + admin-config territory).
- No attempt to script the Priority UI or trigger procedures by any non-OData mechanism.
- No bulk back-fill/migration of historical files.
- Customs-rate *configuration* (setup audit only **reports**, never writes customs %).

## 9. Open questions
None blocking. The `ImpFileQuant`/`ImpFileDates` values are unreadable until `FNCCONST` is API-enabled; until then `close_readiness` reports the FX-basis check as `unknown` with guidance, rather than guessing.
