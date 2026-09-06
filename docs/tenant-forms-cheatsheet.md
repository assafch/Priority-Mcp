# Form-name cheat sheet — ORGAT tenant (`a051014`)

Server `p.priority-connect.online`, environment `tabp008h.ini`, Priority `25.1`.
Every row was probed live with `GET <FORM>?$top=1` on **2026-07-29**. Re-generate at any time:

```bash
node --env-file=.env scripts/live-verify-issues.mjs     # verifies the fixes + prints evidence
```

## The three states a form can be in

Telling these apart is the single most useful thing to know about this API — they look similar
and have completely different fixes.

| State | What you get | What it means | Fix |
|---|---|---|---|
| **exposed** | `200` + rows | entity set exists *and* its "Available for API" flag is on | — |
| **API flag off** | `400 "לא ניתן להפעיל API למסך זה."` | the form **exists**; the flag is off | a Priority admin ticks it in *API/Limited-Access Forms* |
| **absent** | `404` with an **empty body** | no such entity set on this service | wrong name — find the right one with `priority_list_forms({ contains })` |

A `404` is never a permission problem, and a `400` API-flag error is never a wrong name.
`priority_query` / `priority_get_record` now say which one you hit.

Two more `404` shapes, distinguished by body:

- `404` + `"The specified entity was not found"` → the **key** is wrong; the form is fine.
- `404` + empty body on a **composite-keyed** form (`AINVOICES`, `PINVOICES`, `WAREHOUSES`,
  `IMPFILEIV`, `PIVDETAILS`) → a single-value key predicate can never match. Sometimes the same
  mistake surfaces as `400 "The number of keys specified in the URI does not match…"`.

## Exposed and working (verified 2026-07-29)

| Form | What it holds | Key | Notes |
|---|---|---|---|
| `IMPFILES` | import files (תיקי יבוא) | `IMPFNUM` | 7 load-bearing sub-forms; see `impfile_get` |
| `IMPFILEIV` | invoice ↔ import-file links | `IVNUM, DEBIT, TYPE` | lines in `IMPFILEIVS_SUBFORM` (key `KLINE`), each with its own `IMPFNUM` |
| `PINVOICES` | supplier invoices | `IVNUM, DEBIT, IVTYPE` | `IMPFNUM`+`OTYPE='P'` link a file; `STORNOFLAG` = cancelled |
| `PORDERS` | purchase orders | `ORDNAME` | `PORDERITEMS/TRANS/IV` sub-forms drive `po_match` |
| `ORDERS` | sales orders | `ORDNAME` | date field is `CURDATE` |
| `AINVOICES` | sales invoices | `IVNUM, DEBIT, IVTYPE` | date field is `IVDATE`, **not** `CURDATE` |
| `CUSTOMERS` | customers | `CUSTNAME` | no balance field — use `OBLIGO` |
| `SUPPLIERS` | suppliers | `SUPNAME` | no balance field — use `ACCOUNTS_PAYABLE` |
| `LOGPART` | parts (logistics) | `PARTNAME` | on-hand via `PARTBALANCE_SUBFORM`; attachments via `PARTEXTFILE_SUBFORM` |
| `PART` | parts (master) | `PARTNAME` | |
| `PARTPARAM`, `PARTSTATS` | part params / statuses | | |
| `CUSTOMSITEMS` | customs items (פריטי מכס) | `CUSTOMSITEMNAME` | tiered duty %: `PERCENT`/`PERCENT1`/`PERCENT2` |
| `WAREHOUSES` | warehouses | `WARHSNAME, LOCNAME` | `BONDED='Y'` = bonded (מחסן ערובה) |
| `ACCOUNTS` | GL accounts | `ACCNAME` | balances `BALANCE1/2/3`; `CASHNAME ne ''` = bank/cash accounts |
| `ACCOUNTS_PAYABLE` | GL A/P accounts | `ACCNAME` | closest thing to supplier aging here |
| `OBLIGO` | customer balance / credit | `CUSTNAME` | `CREDIT`, `MAX_CREDIT`, `CREDIT_REST` |
| `OPENINVOICES` | open **delivery notes/returns** | `DOCNO` | despite the name — *not* issued tax invoices |
| `COSTINGLOG` | costing (תמחיר) run log | | |
| `FNCCONST`, `FNCTRANS` | finance constants / journal | | |
| `ACCDATES` | accounting period control | | ← the form people look for as `GLPERIODS` |
| `LASTCOUNT` | last stock count per part/warehouse | | ← looked for as `LOGCOUNTERS` |
| `WARHSBALREP` | warehouse balance report | | ← looked for as `WARHSBAL` (empty on this tenant) |
| `IMPFSTATUS` | import-file statuses | | |

`ACCDATES`, `LASTCOUNT` and `WARHSBALREP` were **API-flag-off** in earlier sessions and are now on —
which is exactly why tools probe at runtime instead of hardcoding availability.

## Exists, but "Available for API" is OFF (400, not 404)

`COMPANIES` · `PIVDETAILS` · `PARTBAL` · `COUNTRIES` · `VATTYPES` · `ACCOUNTS_RECEIVABLE` ·
`SALESINVOICEITEMS` · `TODOLIST` · `GENDIARY` · `FAMILY_LOG` · `DOCSTATUSES` ·
`BANKS` · `CASH` · `CASH_BANKS` · `BANKPAGES` · `BANKLINESA` · `BANKRECON`

Each of these is one admin tick away from working. The ones worth asking for:

- **`PIVDETAILS`** — unlocks `impfile_link_invoice({ route: 'final' })` with no code change.
- **`COMPANIES`** — unlocks `priority_list_companies`.
- **`SALESINVOICEITEMS`** — unlocks ranking products by revenue across all products.
- **`PARTBAL`** — per-warehouse stock balances in one query instead of per-part sub-form reads.

## Not on this service at all (404) — and what to use instead

| Name people try | Use instead |
|---|---|
| `GLPERIODS` | `ACCDATES` |
| `LOGCOUNTERS` | `LASTCOUNT` |
| `WARHSBAL` | `WARHSBALREP` |
| `COSTINGLOGCOUNTS` | `COSTINGLOG` |
| `PARTBALANCE`, `LOCWARHSBAL` | `LOGPART('<PARTNAME>')/PARTBALANCE_SUBFORM` (`priority_get_stock_levels`) |
| `IMPFILEITEMS` | `IMPFILES('<IMPFNUM>')/IMPFILEITEMS_SUBFORM` (`impfile_get`) |
| `TRANSIMPFILE` | `IMPFILEIV`, or the `IMPFILES` sub-forms via `impfile_get` |
| `EXTFILES` | `<FORM>('<key>')/EXTFILES_SUBFORM` (`priority_list_attachments`) |
| `BANKACCOUNTS`, `CASHACC` | `ACCOUNTS` filtered `CASHNAME ne ''` (`priority_get_bank_balances`) |
| `AGED_BALANCES`, `OPENDEBT` | `OPENINVOICES` / `OBLIGO` |
| `SUP_AGED_BALANCES`, `SUP_OPENDEBT` | `ACCOUNTS_PAYABLE` |

These are wired into `src/lib/form-aliases.ts`, so hitting one now returns the replacement in the
error itself.

## Attachments

Attachments are a **sub-form of the parent document**, never a global table, and the sub-form's
name varies by form — so it is discovered at runtime from `GetMetadataFor`:

| Form | Attachments sub-form |
|---|---|
| `IMPFILES`, `PORDERS`, `ORDERS`, `ACCOUNTS`, most documents | `EXTFILES_SUBFORM` |
| `LOGPART` | `PARTEXTFILE_SUBFORM` |
| `CUSTOMERS` | `CUSTEXTFILE_SUBFORM` |
| `PARTSTATS` and other lookup tables | none — the tools say so and list what the form does have |

`EXTFILES` columns: `EXTFILENAME` (path — **mandatory**), `EXTFILEDES` (display name — **mandatory**,
≤32 chars), `SUFFIX`, `FILESIZE`, `CURDATE`, `EXTFILENUM` (key, server-assigned).
The service declares **no** media/stream entity, so the API records a *path*; it does not carry bytes.

Proven by a live write round-trip on `IM25000011` (2026-07-29, cleaned up afterwards):
`POST …/EXTFILES_SUBFORM` → Priority assigns `EXTFILENUM` and stamps `USERLOGIN`/`UDATE`; the row
is immediately visible via the sub-form and via `$expand`; `DELETE …/EXTFILES_SUBFORM(EXTFILENUM=n)`
returns `204`. **Priority does not validate the path on insert** — a non-existent path was accepted
with `FILESIZE: 0`, so treat `FILESIZE = 0` as "Priority could not resolve this file".
Replay with `node --env-file=.env scripts/live-verify-attachment.mjs <IMPFNUM>`.

## Quirks worth remembering

- **`contains()` is not supported** (HTTP 501). The search tools fall back to server-side matching;
  the result's `search.strategy` tells you which path ran.
- **`CLOSED eq null` returns HTTP 500.** Use `CLOSED ne 'Y'` for "open".
- **A field can be filterable but not selectable.** `PINVOICES.VATFLAG` filters fine and cannot be
  `$select`ed; the failure is sometimes reported as the opaque
  `"היתה בעיה ביצירת ה-XML…"` and sometimes as `"Could not find a property named 'VATFLAG'"` —
  which one you get depends on the server's model cache. Both now carry a hint.
- **`$metadata` comes back in two different formats.** The identical request alternates between
  CSDL **XML** (`application/xml`, ~10.0MB) and CSDL **JSON**
  (`application/json; odata.metadata=minimal`, ~7.4MB) — observed flipping between consecutive
  calls. Code that assumed XML reported "0 entity types" instead of ~3015. Both are parsed now
  (`src/lib/csdl.ts`). It is also slow (1.5-70s depending on cache state) and occasionally returns
  an empty body, which `priority_list_entities` retries once and then reports.
- **The service document is ~1363 forms / ~65s.** It is cached in-process for 15 minutes, so
  `priority_list_forms` is slow once and instant afterwards.
- **Screen procedures are not OData actions here**: bonded receive/release, the loading calc
  (חישוב העמסה), and possibly file close. The `*_guide` tools return `"mutates": false`.
