# Import Files (תיקי יבוא) — Operating Runbook & Acceptance Tests

How to run the import-file (IMPFILES) tools end to end, including the switch from dry-run to real
writes, the bonded-warehouse flow, and the acceptance-test scenarios.

**Companion docs:** [`kb/impfiles_mapping.md`](../kb/impfiles_mapping.md) (live entity/field mapping),
[`docs/superpowers/specs/2026-07-18-impfiles-mcp-design.md`](superpowers/specs/2026-07-18-impfiles-mcp-design.md)
(design).

---

## 0. Safety model — this build never wrote to Priority

The tools were built and validated **dry-run only** against the live company (`a051014`). Every write
tool defaults to `dryRun=true` (a non-mutating preview of the exact OData body/endpoint), and the
server ran `PRIORITY_READ_ONLY=true` throughout. **No import file, invoice, or PO was created or
modified during development.** This runbook is how you (or the team) execute the real cycle.

Two independent gates protect every write:
1. **`dryRun`** (per call) — `dryRun=true` returns the preview; `dryRun=false` attempts the write.
2. **`PRIORITY_READ_ONLY`** (server) — when `true`, even `dryRun=false` is refused.

To perform a real write you must set BOTH: `PRIORITY_READ_ONLY=false` (server env) **and** `dryRun=false`
(the call). Recommended order for any write: run it once with `dryRun=true`, read the `wouldSend`
body, then re-run with `dryRun=false`.

> Prefer a **test company** for the first full cycle. If you only have the live company, run a single
> throwaway import file end to end, verify, then delete it — and keep `PRIORITY_READ_ONLY=true` for
> everyday use.

---

## 1. One-time Priority-side setup (enable forms for the API)

Enable these in Priority's **"מסכים בהרשאה מוגבלת" / API-Forms** screen (where `IMPFILES` was enabled).
Already open and working: `IMPFILES`, `PINVOICES`, `PORDERS`, `CUSTOMSITEMS`, `COUNTRIES`, `LOGPART`,
`WAREHOUSES`.

| Screen | Why | Impact if left disabled |
|---|---|---|
| **הגדרות כספים למוצרים** (part financial settings) | loading method per cost part | preflight check §3.7.1 stays *advisory* (can't be machine-verified) |
| **קבועי כספים** (`FNCCONST`) | read `ImpFileDates` (FX basis) | tools default to invoice-date basis; confirm it matches your config |
| **ספקים** (`SUPPLIERS`) | validate supplier/forwarder | no supplier-master validation (names still work) |

Everything below works today without these; they only upgrade a few checks from advisory to verified.

---

## 2. Standard operating flow (non-bonded, or before the bonded step)

For each import file. Tool calls shown with the key params; add `dryRun=false` only when you intend the
real write.

1. **Open the file** — `impfile_open { date, currency, supplier, po?, forwarder?, incoterms?, warehouse: "arov", owner }`.
   IMPFNUM is auto-generated. `owner` (OWNERLOGIN) is mandatory in Priority.
2. **Record the goods invoice** — `pinvoice_create { mode: "goods", supplier, invoiceNumber, invoiceDate, currency, impfnum, po, goodsLines: [{part, qty, price?}] }`.
   Omit `price` only when a `po` is supplied (Priority sources the price from the order).
3. **Record the broker/forwarder invoice** — `pinvoice_create { mode: "broker", supplier: <forwarder>, invoiceNumber, invoiceDate, currency: "ש\"ח", impfnum, costLines: [{part, amount, vat?}], declarationVat: [{amount, declaration, declarationDate}], customsDuty?: [...] }`.
   - Freight/insurance/brokerage → `costLines` (each a cost part, e.g. `AVI001`).
   - Import VAT from the רשומון → `declarationVat` (posted to the `מע'מ` system part, one line per declaration).
   - Customs duty (if any — you are effectively duty-free today) → `customsDuty` on the C-loaded מכס part.
4. **Retro-link any pre-existing invoice** (optional) — `impfile_link_invoice { invoiceNumber, impfnum, debit?, ivtype? }`. Refuses to link a storno or to move an already-linked invoice unless `allowRelink=true`.
5. **Three-way match the PO** — `po_match { poNumber }`. Resolve any `qty-gap` / `ordered-not-arrived` / `received-not-invoiced` before closing.
6. **Close supplied PO lines / balances** — `po_close_lines { poNumber }` (procedure-gated; verify via `po_match`).
7. **Run the loading calc** — `impfile_run_calc_guide { impfnum }` returns the instruction (the calc is a screen procedure). Run "חישוב העמסה" in Priority.
8. **Preflight** — `impfile_preflight { impfnum }`. Fix everything in `blocking`; review `advisory`.
9. **Close the file** — `impfile_close { impfnum }`. Refuses while preflight has blocking issues (override with `override=true` only deliberately).
10. **Landed cost** — `impfile_landed_cost { impfnum }` for the value-weighted estimate; the authoritative figure is the product cost after תמחיר.

**Corrections (storno / credit — §3.6):** a cancelled/credit invoice does NOT auto-detach.
`impfile_preflight` flags it as *blocking*. Either detach the original (clear its IMPFNUM) or link the
credit note, then: reopen (`impfile_reopen`) → fix → recalc → reclose → re-run תמחיר if it already ran.

---

## 3. Bonded-warehouse flow (מחסן ערובה — `arov`)

`arov` is a confirmed type-D bonded warehouse (holding location `0` excluded from inventory value;
`arova` is the costed/released location). The bonded receive/release are **screen procedures**; the
tools guide the sequence and verify state by read-back.

1. `bonded_status { warehouse: "arov" }` — confirm the bonded config.
2. Open file + link invoices (§2 steps 1–4).
3. `bonded_receipt_guide { impfnum }` — guide receiving goods into the bonded holding location (this
   closes the PO balance even before release). Read-back shows the goods content.
4. `bonded_fill_detail_guide { impfnum }` — guide filling the pallet/contents detail (תכולה במחסני ערובה).
5. **Close the file** (`impfile_close`).
6. `bonded_release_guide { impfnum }` — guide the release against a rishumon (on the מכס part, partial
   supported, with per-line import costs + additional-costs %). Read-back shows unreleased qty remaining
   and enforces that the file is closed.
7. `bonded_line_costs_guide { impfnum }` — guide registering per-line import costs (file must be closed).

Editing after a partial release: `impfile_reopen` → add → `impfile_close`.

---

## 4. Automated validation already in place

Four live verifier scripts exercise the tools against real data (reads + dry-run previews). Run any of:

```
node --env-file=.env scripts/verify-impfiles-slice1.mjs   # read tools (26 checks)
node --env-file=.env scripts/verify-impfiles-slice2.mjs   # write cycle, dry-run (30 checks)
node --env-file=.env scripts/verify-impfiles-slice3.mjs   # match / preflight / close / landed-cost (21)
node --env-file=.env scripts/verify-impfiles-bonded.mjs   # bonded module (14 checks)
```

Plus `npm test` (141 unit tests over the pure logic: invoice builders, three-way match, preflight,
landed cost, goods read-back). These cover payload correctness and read behavior; the scenarios below
add the **real-write** acceptance layer.

---

## 5. Acceptance-test scenarios (spec §6) — run in a test company

Set `PRIORITY_READ_ONLY=false` and pass `dryRun=false` on the write steps. Each scenario lists its pass
criteria; verify with `impfile_get` / `po_match` between steps.

| # | Scenario | Steps | Pass criteria |
|---|---|---|---|
| 1 | **Full cycle** | open → goods invoice → broker invoice (VAT on `מע'מ`, duty on the `C` part) → `po_match` → `po_close_lines` → `impfile_run_calc_guide` → `impfile_preflight` → `impfile_close` → `impfile_reopen` → `impfile_close` | file closes clean; reopen then reclose succeeds; `impfile_get` shows both invoices |
| 2 | **Cost invoice to two files (per-line link)** | broker invoice with lines split across two files | lines appear under `manualCostAllocations` / `extraProductLines`, NOT under `invoices`; `impfile_get` shows them |
| 3 | **Partial supply** | PO partially received | `po_match` shows `qty-gap`; `po_close_lines` closes supplied, leaves the balance; file still closes |
| 4 | **Storno on a linked invoice** | cancel a linked invoice | `impfile_preflight` flags it *blocking*; both correction routes (detach original / link credit) clear it |
| 5 | **Broker invoice, two declarations** | `declarationVat: [{...}, {...}]` | two `מע'מ` lines, each with its own `CUSTOMSNUM` per line |
| 6 | **Cost-only file** | file with only cost lines | `impfile_preflight` blocks with "only cost lines" |
| 7 | **Weight loading, no weights** | weight-loaded part with `WEIGHT=0` | `impfile_preflight` advises "weights not populated / would split evenly" |

**Bonded acceptance (§Phase 5):** open → link → `bonded_receipt_guide` → `bonded_fill_detail_guide` →
`impfile_close` → `bonded_release_guide` (partial) → `bonded_line_costs_guide`; verify unreleased qty
decreases on release and that line-costs is refused while the file is open.

---

## 6. Open items / caveats

1. **Procedure-gated writes** — `po_close_lines`, `impfile_close`, `impfile_reopen`, and the loading
   calc may require the Priority screen procedure rather than a field PATCH. The tools preview the
   PATCH and, if Priority rejects it, guide the screen step + verify by read-back. Confirm on the first
   real run.
2. **Coded-not-observed** — `impfile_manual_alloc` / `impfile_expected_costs` target sub-forms this
   company has never used (0/114 files); their exact line-field names are unverified — confirm against
   a real allocation before relying on them.
3. **Duty path** — imports are effectively duty-free here; the `C`-loaded customs (מכס) part is coded
   per spec but never exercised in live data. Supply the duty part code if duty ever applies.
4. **Per-line / final link routes** of `impfile_link_invoice` need the "חשבוניות לתיקי יבוא" /
   "עדכון פרטים לחשבוניות ספק" screens, whose OData entity isn't mapped yet — use the header route.
5. **`ImpFileDates`** (FX basis) isn't API-readable unless `FNCCONST` is enabled — tools assume the
   invoice-date basis; confirm it matches your Priority constant.
