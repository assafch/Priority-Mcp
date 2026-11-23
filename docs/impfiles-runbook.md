# Import Files (תיקי יבוא) — Operating Runbook & Acceptance Tests

How to run the import-file (IMPFILES) tools end to end, including the switch from dry-run to real
writes, the bonded-warehouse flow, and the acceptance-test scenarios.

**Companion docs:** [`kb/impfiles_mapping.md`](../kb/impfiles_mapping.md) (live entity/field mapping),
[`docs/superpowers/specs/2026-07-18-impfiles-mcp-design.md`](superpowers/specs/2026-07-18-impfiles-mcp-design.md)
(design).

---

## Official process (added 23.11.2026)

The order below is Priority's own: SOP "תיקי יבוא" (LBI2400273, local copy in the finance docs)
and "עבודה עם מחסן ערובה" (LBI2400656,
`https://cdn.priority-software.com/docs/SOP_BondedWarhs_23_1_H.pdf`).

1. open the file → 2. link invoices, with the import declaration and the country of origin on every
goods line → 3. close the invoices (T→GI) → 4. receipt into `arov` → 5. "מילוי פירוט למחסן ערובה" →
6. "חישוב העמסה" (review; repeat after every change) → 7. "סגירת התיק" → 8. release document
(draft) → 9. "רישום עלויות יבוא לשורה" (file closed, release still a draft) → 10. release final →
11. "תמחיר לתאריך נוכחי" → 12. landed cost per product.

`impfile_preflight` reports where a file stands on these twelve steps (`official`); its
`nextAction` names who does the step. `impfile_cost_report` gives step 12.
`impfile_costing_readiness` is the company-wide check before step 11. Sections 2–3 below predate
this and describe the tool calls; where they differ in order, this list wins.

### Who does each step

| Step | Done by | Leaves |
|---|---|---|
| 2 declaration on each goods line | `pinvoice_set_declaration` (invoice still a draft) | — |
| 3 close the invoices | the owner (`priority_close_invoice`, approved per invoice) | — |
| 4 receipt into `arov` | `bonded_receipt` | a DRAFT; the owner makes it final |
| 5 fill detail | `bonded_fill_detail` (program `FILL_IMPFILES`) | pallet number is not written |
| 6 loading calculation | `impfile_run_calc` (program `IMPFILE2`) | — |
| 7 close the file | the owner, in the screen ("סגירת התיק") | — |
| 8 release document | `bonded_release_draft` | a DRAFT |
| 9 per-line import costs | `bonded_line_costs` (program `IMPORTCOSTPERLINE`) on the draft | — |
| 10 release final | the owner, in the screen | — |
| 11 costing | the owner ("תמחיר לתאריך נוכחי") | — |

The five steps left to the owner cannot be undone over the API. The six tools never write a
document status and never run the close or the costing.

### Contract of the six executing tools

- `dryRun` defaults to `true`: the plan, nothing sent. Nothing is sent when `PRIORITY_READ_ONLY=true`.
- Order inside every tool: read → "already-done" from what Priority shows → gate → write → re-read.
  A precondition that could not be read is a refusal.
- `status`: `preview` · `refused` · `blocked` · `done` (confirmed by re-reading) · `already-done` ·
  `incomplete` (a draft exists but is not complete; calling again continues it, never a second
  document) · `unverified` (sent, result not visible: wait 180 s, re-read, do not resend) ·
  `cancelled` (a program asked something unexpected and was cancelled unanswered) · `failed`.
- Programs run once through the Web SDK as a direct activation of the row. An information message
  is confirmed; a warning is answered only if its exact text is in `acceptPrompts`; an input dialog
  cancels the run and is returned in `procedure.steps`.
- Every write or program attempt is appended to `output/import-step-attempts.jsonl` before it is
  sent and again with its result (refusals and previews are not recorded). Both files under
  `output/` are git-ignored: they hold real document numbers.
- One caller at a time per step and file: a claim file under `output/import-step-claims/` stops a
  second process on the same machine. Servers on DIFFERENT machines (this Mac and the bot's host)
  share neither the claim nor the ledger; between them the only protection is that a tool re-reads
  what already exists in Priority right before it creates a document.
- A draft that already carries quantities other than the requested ones is never overwritten; the
  tool refuses and names the lines.
- The six tools get a three-minute budget per call (other tools: twenty seconds), so a program
  that ends cleanly is not cut off before its re-read.
- Before believing an empty read where a create would follow (no receipt yet, no release yet, an
  invoice "not found"), a tool reads the same form once more without any filter. These forms are
  never empty, so if that read is empty too the tool answers `blocked`, sends nothing and leaves no
  cooldown: try again in a few minutes. (On 2026-11-23 the supplier-invoice reads came back empty
  for a while although the invoices existed.)
- `"piloted": false` on every result until the tool passed its pilot (below); `true` after.

### Pilot protocol

The three programs were never run through the SDK on this tenant before, and "רישום עלויות יבוא
לשורה" was never run on a DRAFT release here. The first REAL run of each tool is therefore a
pilot: on a real file that is being processed anyway, with the owner watching the screen.

For each tool, in this order:

1. `dryRun: true` — read the plan (`wouldSend` / `wouldRun`) and any `warnings`.
2. Programs only: `dryRun: true, probe: true` — the SDK logs in and finds the row; `probe.rowFound`
   must be `true`, `probe.mismatch` `null`, and `probe.activation` must show `background: 0`.
3. `dryRun: false`, once.
4. Record the read-back checks below. Only a clean run plus clean checks counts as piloted.

| Tool | Check after the real run (in the screen and by re-reading) |
|---|---|
| `pinvoice_set_declaration` | every product line of the draft invoice shows the declaration number and date; the `מע'מ` line is untouched |
| `bonded_receipt` | one receipt, status טיוטא, warehouse `arov` / location `0`; every line quantity equals the invoice; total equals the invoice total |
| `bonded_fill_detail` | "תכולה במחסני ערובה" lists every product of the goods invoice with the invoice quantity; the `מע'מ` line is 0 |
| `impfile_run_calc` | "אומדן מכס" has a row per product, each with a country of origin; `impfile_close` shows `lastCalcViaTool` |
| `bonded_release_draft` | one release, status טיוטא, declaration as given, quantities as requested; no second document |
| `bonded_line_costs` | "עלויות יבוא לשורה" on every line; `lines[].totalILS` equals the screen; for a full release `reconciliation.status` is `ties` or `ties-within-rounding` |

Observe and record during the pilots — Priority behaviour that could not be read in advance and
that the tools' handling depends on:

- `TQUANT` on freshly pulled receipt lines and release lines, before the tool writes them (0, or
  already the full quantity?). It decides whether a tool's own half-made draft can be continued:
  a line that carries another non-zero quantity is treated as entered by someone and not overwritten.
- Whether `PQUANT` on a release line is the balance still in bond (the tool compares it with the
  content balance; if it is the original quantity, a second partial release reports `incomplete`).
- Whether a DRAFT release already lowers the content balance (`TBALANCE`). If it does, a second
  `bonded_release_draft` call answers "no balance" instead of `already-done` — harmless, but note it.
- Whether cost rows exist on a draft release before "רישום עלויות יבוא לשורה" runs (matters only
  for a file with no cost invoice, where a cost of 0 counts as registered).
- How long each program takes (the SDK waits 30 s per step; a longer program is reported
  `unverified`), and the exact text of every message or prompt it shows.

When a result is not `done`:

- `cancelled` — a program asked something. Nothing is retried. Read `procedure.steps`: it holds the
  exact text. Re-read the file to see whether anything changed. A warning may be accepted only
  after the owner has seen its exact text and approved it; only then is that text passed in
  `acceptPrompts` on the next run. The bot never adds a text to `acceptPrompts` by itself. An
  error message or an input dialog means the step is done in the screen and the tool needs a
  follow-up change.
- `incomplete` — a draft exists (`docno`). Do not create another. Read `verification.reason`; fix
  what it names in the screen, or call the same tool again to continue.
- `unverified` — the write or the program was sent and the result is not visible, or cannot be
  proven: a create that got no answer, a cancel Priority did not confirm, a program that ended
  with a message, per-line costs that do not tie to the cost invoices, a rerun whose rows did not
  change. Wait for the time in the refusal (180 s), re-read with `impfile_preflight`, and only
  then decide.
- `refused` — nothing was sent; `reasons` says what is missing.

After a clean pilot, mark the tool as piloted here, with the date and the file, and set its value
in `PILOTED` (`src/services/import-steps.ts`) in the same change:

| Tool | Piloted on | File |
|---|---|---|
| `pinvoice_set_declaration` | 2026-11-23 | an open file at step 2; two lines, checked by re-read and on screen |
| `bonded_receipt` | — | — |
| `bonded_fill_detail` | — | — |
| `impfile_run_calc` | — | — |
| `bonded_release_draft` | — | — |
| `bonded_line_costs` | — | — |

Known limits: country of origin is written only where the countries table is exposed to the API (it
is not on this tenant); a partial quantity for a part that sits on several release lines is set in
the screen; the late-invoice path (reopen the release, "לבצע חישוב חוזר") is not covered; a file whose
receipt was entered against purchase-order lines shows step 4 as unknown and continues in the
screen.

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
9. **Close the file** — Assaf runs "סגירת התיק" in the import-file screen. `impfile_close { impfnum }` only reports readiness (`readyToClose`, `nextStep`, `stage`); it never writes.
10. **Landed cost** — `impfile_landed_cost { impfnum }` for the value-weighted estimate; the authoritative figure is the product cost after תמחיר.

**Corrections (storno / credit — §3.6):** a cancelled/credit invoice does NOT auto-detach.
`impfile_preflight` flags it as *blocking*. Either detach the original (clear its IMPFNUM) or link the
credit note, then: Assaf reopens in the screen ("ביטול סגירה של התיק"; `impfile_reopen` only reports the state) → fix → recalc → reclose → re-run תמחיר if it already ran.

---

## 3. Bonded-warehouse flow (מחסן ערובה — `arov`)

`arov` is a confirmed type-D bonded warehouse (holding location `0` excluded from inventory value;
`arova` is the costed/released location). Since 23.11.2026 each reversible step has an executing
tool (see "Who does each step" above); the `*_guide` tools below only explain and read back.

1. `bonded_status { warehouse: "arov" }` — confirm the bonded config.
2. Open file + link invoices (§2 steps 1–4).
3. `bonded_receipt_guide { impfnum }` — guide receiving goods into the bonded holding location (this
   closes the PO balance even before release). Read-back shows the goods content.
4. `bonded_fill_detail_guide { impfnum }` — guide filling the pallet/contents detail (תכולה במחסני ערובה).
5. **Close the file** — in the screen; check readiness first with `impfile_close`.
6. `bonded_release_guide { impfnum }` — guide the release against a rishumon (on the מכס part, partial
   supported, with per-line import costs + additional-costs %). Read-back shows unreleased qty remaining
   and enforces that the file is closed.
7. `bonded_line_costs_guide { impfnum }` — guide registering per-line import costs (file must be closed).

Editing after a partial release: reopen in the screen → add → close in the screen.

After every release: run "רישום עלויות יבוא לשורה" on the release, then verify with
`bonded_line_costs_guide` (`linesWithoutCost` must be 0), then תמחיר.

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

0. **Stage lock (23.11.2026)** — the server refuses any field write of an import file's status
   (`CLOSED` / `STATDES`) and any write to a bonded release (`DOCUMENTS_J`), for every tool and script
   (`src/lib/import-stage-guard.ts`). `impfile_close` / `impfile_reopen` are read-only checks; the
   scenarios in §5 that close, reopen or release are done in the screen.
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
