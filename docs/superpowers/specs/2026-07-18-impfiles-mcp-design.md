# Design — IMPFILES (תיקי יבוא) support in the Priority MCP server

**Date:** 2026‑07‑18 · **Status:** approved to build (Slice 1) · **Company:** a051014 (live, read‑only)
**Companion:** `kb/impfiles_mapping.md` (Phase‑0 discovery — the source of every entity/field below).

This design adapts the Hebrew upgrade prompt (`mcp_impfiles_upgrade_prompt.md`, written for a
Python/FastMCP server) to the **actual TypeScript server** and to the **live‑verified** Priority
schema. It is the plan for three review‑gated slices + an in‑scope bonded module.

---

## 1. Architecture & where code goes

Follow existing patterns exactly (see `src/tools/purchase-orders.ts`, `src/tools/generic.ts`,
`src/lib/write-guard.ts`, `src/lib/priority-schema.ts`).

| New/changed file | Purpose |
|---|---|
| `src/tools/impfiles.ts` | All import‑file tools; `registerImpfileTools(server, client, config)` |
| `src/tools/impfiles-bonded.ts` | Bonded‑warehouse tools; `registerBondedTools(...)` (Phase 5) |
| `src/lib/impfiles-logic.ts` | **Pure** business logic (customs, FX, storno, preflight, landed cost) — unit‑tested, no Priority calls |
| `src/lib/priority-schema.ts` | Add `IMPFILES`, `PINVOICES`, `CUSTOMSITEMS` schema entries |
| `src/tools/index.ts` | Register the two new tool modules |
| `tests/impfiles-logic.test.ts` | Unit tests for the pure logic |
| `README.md` | Document the new tools |
| `docs/impfiles-runbook.md` | Hand‑over runbook for the real write cycle (dry‑run‑only build) |

**Design principles (match the codebase):**
- Every tool: Hebrew‑aware docstring, `zod` input shape, `try/catch → toMcpError(err)`, `textResult(...)`.
- Reads use `ODataBuilder` + `client.list/get`; return Priority errors verbatim (already handled by `toMcpError`).
- Writes: `dryRun: z.boolean().default(true)` + `previewOrBlock(config, dryRun, ACTION, body)`; the
  server stays `PRIORITY_READ_ONLY=true`. **No real writes during the build** — payloads are validated
  by dry‑run only. (User decision: dry‑run‑only on live; runbook covers the real cycle.)
- Business logic lives in `impfiles-logic.ts` as pure functions so it's unit‑tested and does **not**
  rely on chat‑Claude's memory (spec Definition of Done).

---

## 2. Schema registry additions (`priority-schema.ts`)

```
IMPFILES:  key ['IMPFNUM'], dateField 'CURDATE', nameField 'SUPDES',
           searchFields ['IMPFNUM','SUPDES','CUSTOMSNUM','ORDNAME'],
           defaultSelect ['IMPFNUM','CURDATE','SUPDES','STATDES','CLOSED','ORDNAME','CODE','WARHSNAME'],
           lineSubform 'IMPFILEITEMS_SUBFORM'
PINVOICES: key ['IVNUM','DEBIT','IVTYPE']  (COMPOSITE — query by $filter on IVNUM, never .get()),
           dateField 'IVDATE', nameField 'SUPDES',
           defaultSelect ['IVNUM','IVDATE','SUPNAME','SUPDES','STATDES','DISPRICE','VAT','TOTPRICE','CODE','IMPFNUM','OTYPE','FINAL','STORNOFLAG'],
           lineSubform 'PINVOICEITEMS_SUBFORM'
CUSTOMSITEMS: key ['CUSTOMSITEMNAME'], nameField 'CUSTOMSITEMDES'
```

---

## 3. Tools — Slice 1 (READ; reads only, live‑verified)

### `impfile_search`
`GET IMPFILES?$filter=…&$orderby=CURDATE desc`. Inputs (all optional): `status` (STATDES), `closed`
(→ `CLOSED eq 'Y'` / `ne`), `supplier` (SUPNAME/SUPDES), `poNumber` (ORDNAME), `declaration`
(CUSTOMSNUM), `dateFrom`/`dateTo` (CURDATE via `dateFrom`/`dateTo` helpers), `top`, `skip`. Returns
projected rows via `defaultSelect`.

### `impfile_get`
`GET IMPFILES('IMxxxx')?$expand=` **all seven** load‑bearing sub‑forms:
`IMPFILEINV_SUBFORM, MANIVDUTIES_SUBFORM, MANIVPARTS2_SUBFORM, EXPIVDUTIES_SUBFORM,
IMPFILECUSTOMS_SUBFORM, IMPFILEITEMS_SUBFORM, IMPFILEPORDI_SUBFORM`. Returns a **normalized snapshot**:
header + `{invoices, manualCostAllocations, extraProductLines, expectedCosts, customsEstimate,
goodsContent, linkedPoLines}` + a `derived` block (totals per currency, invoice count by
goods/broker heuristic, whether manual allocations exist). Uses `client.get` (single key OK). Large
results are already capped by `textResult`.

---

## 4. Tools — Slice 2 (CORE WRITE CYCLE; dry‑run‑validated)

### `impfile_open` — `POST IMPFILES`
Body: `{ CURDATE, CODE, OWNERLOGIN, STATDES:'טיוטא', SUPNAME?, ORDNAME?, IMPTERMNAME?, SHIPPERNAME?,
SUPNAME2?, WARHSNAME?, CUSTOMSNUM?, CUSTOMSDATE? }`. `IMPFNUM` auto‑generated. Documents that
`WARHSNAME` defaults to the bonded warehouse (`arov`).

### `impfile_update` — `PATCH IMPFILES('IMxxxx')`
Header/status/country fields. Notes in the tool response that country‑of‑origin default in Priority is
the supplier's country (per spec §4).

### `pinvoice_create` — `POST PINVOICES` (deep‑insert `PINVOICEITEMS_SUBFORM`)
Two modes (discriminated union on `doc_type`):
- **goods** (`supplier_invoice`): header `{ SUPNAME (foreign), IVDATE, BOOKNUM (supplier inv#), CODE
  (foreign), DEBIT:'D', OTYPE:'P', IMPFNUM, ORDNAME? }`; lines = SKUs `{ PARTNAME, TQUANT, PRICE }`.
- **broker** (`broker_invoice`): header `{ SUPNAME (forwarder), IVDATE, BOOKNUM, CODE:'ILS', DEBIT:'D',
  OTYPE:'P', IMPFNUM }`; lines built by `buildBrokerLines()`:
  - customs duty → dedicated **C‑loaded duty part** (param `duty_part`; **duty‑free today** so usually absent);
  - **import VAT from declaration → part `מע'מ`** (PDES "סכום המע'מ ברשומון של המכס"), `VATFLAG:'Y'`,
    with `CUSTOMSNUM`/`CUSTOMSDATE` on the line; **one line per declaration** (spec §3.1);
  - other costs → the caller's cost parts (e.g. `AVI001` freight, `AVI003` insurance, `AVI007`
    brokerage…), each `TQUANT:1`, manual `PRICE`, `VATFLAG` per part.
  Amounts stay in source currency; Priority applies FX (spec §3.4, guardrail §4.2). Supports equipment
  input‑VAT via VAT code `003` as a parameter (spec §3.1).

### `impfile_link_invoice` — link an existing invoice to a file, four routes
- **at entry**: set header `IMPFNUM` + `OTYPE:'P'` on create (folded into `pinvoice_create`).
- **retro, header level**: `PATCH PINVOICES(key) { IMPFNUM, OTYPE:'P' }` (key via composite `$filter`→PATCH).
- **retro, per line**: the "חשבוניות לתיקי יבוא ← פירוט" route — per‑line file / country / declaration.
- **final invoice**: update the finalized supplier invoice's link ("עדכון פרטים לחשבוניות ספק").
Because `PINVOICES` has a composite key, the tool resolves `IV`/key via `$filter` first, then PATCHes.

### `impfile_manual_alloc` — `POST …/MANIVDUTIES_SUBFORM` or `…/MANIVPARTS2_SUBFORM`
Ratio allocations: a cost from an invoice → `MANIVDUTIES_SUBFORM`; a manually added item →
`MANIVPARTS2_SUBFORM` (spec §1 tool 7).

### `impfile_expected_costs` — `POST …/EXPIVDUTIES_SUBFORM`
Records expected costs feeding the expected/actual report (spec tool 14).

---

## 5. Tools — Slice 3 (MATCH / CLOSE / PREFLIGHT / LANDED COST)

### `po_match` — 3‑way match (read‑only)
`GET PORDERS('PO…')?$expand=PORDERITEMS_SUBFORM,PORDERTRANS_SUBFORM,PORDERIV_SUBFORM` (+ the file's
invoices). `matchThreeWay()` in `impfiles-logic.ts` joins by `PARTNAME` and returns per line:
`ordered / received / invoiced / balance` and a verdict ∈ { matched, qty‑gap, price‑gap,
ordered‑not‑arrived, arrived‑not‑ordered, received‑not‑invoiced }. **Bonded caveat (in scope):** a
receipt into `arov` closes PO balances even before release — `matchThreeWay` counts `PORDERTRANS`
receipts regardless of release state (spec §5).

### `po_close_lines` — close supplied lines / force‑close remainders
`PATCH` PO line / PO close flags (`CLOSEDBOOL`, `BOOLPCLOSED`). **Procedure‑gated** — verify whether a
field PATCH suffices or a Priority procedure is required (open item §8 of mapping); fallback =
UI‑guided + read‑back. Supports partial close.

### `impfile_run_calc` — run loading calculation
Attempt an OData action if one exists; else **guide + verify** (read back recomputed cost fields).

### `impfile_preflight` — pre‑close diagnostics (8 checks, spec §3.7)
Pure `preflight()` over an `impfile_get` snapshot + masters:
1. every cost part has a loading method — **advisory** (form not API‑exposed, §1b of mapping).
2. ≥1 purchased part with no loading method (else "no product invoices linked").
3. weight‑based loading but `WEIGHT` unpopulated / no main weight unit → warn (even split).
4. country‑of‑origin present per line or supplier default valid.
5. every duty‑liable part has a customs item (`IMPFILECUSTOMS.CUSTOMSITEMNAME`) — **verifiable**; but
   **duty‑free here**, so emitted as info, not error.
6. unhandled credit/storno on a linked invoice (`STORNOFLAG`, `DEBIT='C'`).
7. loading calc ran after the last change.
8. customs & VAT: declaration ↔ broker invoice ↔ estimate within threshold.
Returns `{ ok, blocking[], advisory[] }`. `impfile_close` refuses unless `blocking` is empty or
explicitly overridden.

### `impfile_close` / `impfile_reopen`
Close only after clean preflight (guardrail §4.3). PATCH `CLOSED`/`STATDES` or procedure + read‑back
verify. Reopen for corrections; guides the reopen→fix→recalc→reclose→(re‑cost) sequence (spec §3.6/§4.4).

### `impfile_landed_cost`
Prefer reading Priority's post‑calc result; **fallback** = `computeLandedCost()` in `impfiles-logic.ts`
applying the two‑stage loading (spec §3.5): (a) split each cost across products by that cost part's
loading method; (b) split across a product's invoices by amount. Reflects the §3.4 FX basis.

---

## 6. Bonded module (Phase 5 — IN SCOPE, user‑confirmed)

`src/tools/impfiles-bonded.ts`. All **read + UI‑guided + read‑back verify** (bonded procedures are
UI‑only). First step at build time: enable `WAREHOUSES` data and confirm `arov` `BONDED='Y'`,
`TYPE='D'`, `COSTFLAG` (excluded from inventory value). Tools: `bonded_receipt_create`,
`bonded_release_create` (release against declaration, on the customs part, partial supported),
`bonded_fill_detail`, `bonded_line_costs` (import costs to a released line — file must be closed).
Editing after release: reopen doc → recompute → reclose (spec §Phase 5).

---

## 7. Business‑logic module (`impfiles-logic.ts`) — pure, unit‑tested

- `computeCustoms(part, customsItem, country)` → duty/purchase‑tax per spec §3.3
  (`duty = duty% × price`; `purchaseTax = purtax% × (1+additions%) × (price+duty)`), duty% column
  chosen by `COUNTRIES.CUSTOMSTYPE` (general/EU/N.America).
- `matchThreeWay(orderItems, transItems, invItems)` → per‑line verdicts (§5).
- `preflight(snapshot, masters)` → `{ ok, blocking, advisory }` (§5).
- `computeLandedCost(snapshot, methods, fxBasis)` → per‑SKU landed cost (§5, fallback).
- `detectStorno(invoices)` → flags credit/storno needing one of the two correction routes (§3.6).
Each has table‑driven unit tests using the real numbers captured in `kb/impfiles_mapping.md`.

---

## 8. Guardrails (spec §4)
1. Every write: dry‑run → preview → explicit confirm → execute (via `previewOrBlock`).
2. Amounts in source currency; **no client‑side FX at write time** — Priority converts per §3.4.
3. `impfile_close` blocked unless `impfile_preflight` is clean (or explicit override).
4. Linking to a closed file → guided reopen → link → recalc → close → (re‑cost).
5. Full log line per write (existing `logger`).

---

## 9. Testing & acceptance
- **Unit:** `impfiles-logic.ts` (customs, match, preflight, landed cost, storno) — must stay green with
  the existing `vitest` suite.
- **Live read verification (build‑time):** each read tool run against real closed files
  (`IM25000009`, `IM24000014`, `PO25000003`) and diffed against known values.
- **Write validation (build‑time):** dry‑run previews only — assert exact method/endpoint/body.
- **Acceptance (runbook, user‑run):** the 7 scenarios from spec §6, executed by the user in a test
  company or on a throwaway file, following `docs/impfiles-runbook.md`.

## 10. Sequencing (thin slices, review between — user decision)
- **Slice 1** — schema entries + `impfile_search`, `impfile_get`. Reads only. Review.
- **Slice 2** — `impfile_open`, `impfile_update`, `pinvoice_create`, `impfile_link_invoice`,
  `impfile_manual_alloc`, `impfile_expected_costs`. Dry‑run validated. Review.
- **Slice 3** — `po_match`, `po_close_lines`, `impfile_run_calc`, `impfile_preflight`,
  `impfile_close`/`impfile_reopen`, `impfile_landed_cost`. Review.
- **Bonded** — the 4 bonded tools once `WAREHOUSES` is enabled.
- **Docs** — README + runbook + acceptance scenarios.
