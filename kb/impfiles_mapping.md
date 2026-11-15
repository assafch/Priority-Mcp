# IMPFILES (תיקי יבוא) — Phase‑0 Discovery & Mapping

> **Status:** Phase‑0 discovery deliverable for the IMPFILES MCP upgrade. All facts below were
> live‑verified against company **a051014** (host `p.priority-connect.online`, env segment
> **`tabula.ini`**, user `Assaf`, read‑only) on **2026‑07‑18** via `GetMetadataFor` + bounded
> reads. **This is the approval gate — no tool code is written until this mapping is approved.**
>
> ⚠️ The upgrade prompt assumed a **Python/FastMCP** server with 7 tools. The real server is
> **TypeScript** (`priority-mcp-server`, `@modelcontextprotocol/sdk` + `zod`, ~80 tools, a
> `previewOrBlock` dry‑run gate, a verified per‑form schema map in `src/lib/priority-schema.ts`).
> Every "pydantic/Python" instruction is adapted to the existing TypeScript patterns — same
> architecture, same dry‑run mechanism.

---

## 0. Headline feasibility

**The upgrade is feasible against this live company.** The single biggest risk from the prior
project memory — "IMPFILES is API‑blocked" — is **stale**. `IMPFILES` and every entity the core
flow needs are now API‑reachable and return real data:

| Concern | Result |
|---|---|
| IMPFILES readable/writable via OData | ✅ 42 fields, live sample `IM25000012` |
| Supplier invoices (goods + broker) | ✅ `PINVOICES` (+ `PINVOICEITEMS_SUBFORM`) |
| Purchase orders + 3‑way‑match data | ✅ `PORDERS` (+ items / receipts / invoices sub‑forms) |
| Customs‑item master (§3.3) | ✅ `CUSTOMSITEMS` (+ `CUSTOMSCOUNTRY_SUBFORM`) |
| Country → customs classification | ✅ `COUNTRIES.CUSTOMSTYPE` |
| "VAT‑from‑declaration" system part (§3.1) | ✅ found: part `מע'מ` — see §5 |

---

## 1. API accessibility matrix (this company, today)

### Data‑queryable (read + candidate for write)
`IMPFILES`, `PINVOICES`, `PORDERS`, `CUSTOMSITEMS`, `COUNTRIES`, `LOGPART`, and all IMPFILES/
PINVOICES/PORDERS sub‑forms listed below.

### Metadata‑visible but DATA‑BLOCKED — 400 "לא ניתן להפעיל API למסך זה"
- `WAREHOUSES` → cannot read the warehouse master, so **can't directly confirm `arov` is a type‑D
  bonded warehouse** (see §9).
- `PART` → the manufacturing item card is data‑blocked (metadata only).
- `FNCCONST` → **cannot read `ImpFileDates` / `ImpFileQuant` values** that govern §3.4 FX basis.
  → Tools will default per Priority convention and document it, not read it live.

### Not exposed at all (404 "netprest return no data")
- `PARTSFNC`, `LOGPARTFNC`, `PARTCOST` — i.e. the **"הגדרות כספים למוצרים"** financial‑settings
  form (loading method / per‑part customs‑item / weight / volume) is **not on the API here**.
  Consequence: **loading‑method‑per‑cost‑part is not queryable** → preflight check §3.7.1 becomes
  *advisory* (can't be machine‑verified). Per‑part customs‑item *is* still visible per‑file via
  `IMPFILECUSTOMS_SUBFORM.CUSTOMSITEMNAME`, so §3.7.5 remains verifiable.

---

## 1b. Priority‑side: screens to enable for API (like FNCCONST)

Enable these in Priority's **"מסכים בהרשאה מוגבלת" / API‑Forms** screen (same place `IMPFILES` was
enabled). Tiered by impact on this feature.

### Tier 1 — removes a real limitation
| Screen (Hebrew) | Entity | Current | Enabling unlocks |
|---|---|---|---|
| מחסנים | `WAREHOUSES` | data‑blocked (metadata only) | Confirms `arov` is bonded — fields `BONDED` ("מחסן ערובה?"), `TYPE` (D/F/W), `COSTFLAG` ("נכלל בערך מלאי"), `COSTTRANSFLAG`. **Settles the bonded‑module decision + inventory‑value logic.** |
| **הגדרות כספים למוצרים** | *(unknown — not on API)* | **not exposed** under `PARTSFNC`/`LOGPARTFNC`/`PARTCOST`/`PARTFNC` (all 404) | loading method (אופן העמסה) per cost part, per‑part customs‑item assignment, weight/volume, std costs A/S/L → makes preflight §3.7.1 machine‑verifiable + enables self‑compute landed cost. **Need the exact Priority form name/number from the user.** |
| קבועי כספים | `FNCCONST` | data‑blocked (metadata only) | read `ImpFileDates` / `ImpFileQuant` so §3.4 FX basis is read, not assumed. |

### Tier 2 — nice‑to‑have (feature works without)
| Screen | Entity | Current | Enabling unlocks |
|---|---|---|---|
| ספקים | `SUPPLIERS` | data‑blocked | validate goods supplier + forwarder; import terms; supplier‑part import costs (`SUPPART_SUBFORM`). |
| מאפיינים נוספים למוצר | `PARTPARAM` | data‑blocked | `CLORDTOL`/`CLORDTOLNUM` = PO auto‑close thresholds → smarter `po_close_lines`. |
| קבלות סחורה מספק | *(goods‑receipt doc)* | via `PORDERTRANS` only | receipt‑level ops; **matching already works without it**. |

### Already open (no action) — `IMPFILES`, `PINVOICES`, `PORDERS`, `CUSTOMSITEMS`, `COUNTRIES`, `LOGPART`.
### Not needed — `PART` (data‑blocked, but `LOGPART` covers items).

---

## 2. IMPFILES header — screen → entity → critical fields

Form **`IMPFILES`** ("תיקי יבוא"), key **`IMPFNUM`** (`IM25000012`), single‑value key (`get` works).

| Field | Title | Use |
|---|---|---|
| `IMPFNUM` | תיק יבוא | key (auto‑generated on open) |
| `CURDATE` * | ת. פתיחה | open date (mandatory) |
| `CODE` * | מטבע תיק היבוא | file currency (mandatory) |
| `STATDES` * | סטטוס | `טיוטא` (draft) / `סופי` (final) |
| `OWNERLOGIN` * | לטיפול | handler (mandatory) |
| `SUPNAME`/`SUPDES` | ספק | goods supplier |
| `SUPNAME2`/`SUPDES2` | חברת שילוח עמילות | forwarder/broker |
| `ORDNAME` | הזמנה | linked PO |
| `IMPTERMNAME` | תנאי יבוא | Incoterms (EXW/FOB/C&F…) |
| `SHIPPERNAME` | חברת הובלה | shipper |
| `CUSTOMSNUM` + `CUSTOMSDATE` | הצהרת יבוא + תאריך | declaration (header‑level; **null on all 30 files** — this business records the declaration per line/invoice, not here) |
| `CLOSED` | סגור | `Y` when closed |
| `WARHSNAME` | **מחסן ערובה** | bonded warehouse — **`arov` on 100% of files** |
| `IMPFILE` | מספר תיק (ID) | internal numeric id |

\* mandatory. **30/30 files** are in warehouse `arov`; statuses seen: `טיוטא`, `סופי`.

### IMPFILES sub‑forms (navigation properties)
| Sub‑form | Spec role | Verified contents |
|---|---|---|
| `IMPFILEINV_SUBFORM` | חשבוניות ספק | linked invoices: `IVNUM`, `IVCODE`='חסמ', `SUPIVNUM` (supplier inv#), `DEBIT`, `DISPRICE`/`VAT`/`TOTPRICE`, `CODE`, `TYPE`='P' |
| `IMPFILEITEMS_SUBFORM` | תכולת התיק (goods) | `PARTNAME`, `SUPPARTNAME`, `TQUANT`, `TBALANCE`, `PRICE`, `QPRICE`, `CODE`, **`WEIGHT`/`WUNITNAME`** (weight‑based loading), `KLINE` |
| `IMPFILEPORDI_SUBFORM` | שורות הזמנת רכש בתיק | PO line ↔ file ↔ goods invoice: `ORDNAME`,`LINE`,`PARTNAME`,`TQUANT`,`IVNUM`,`IVLINE`,`IVTQUANT`,`ORDI` |
| `IMPFILECUSTOMS_SUBFORM` | **אומדן מכס** | per‑part `COUNTRYNAME`, `CUSTOMSITEMNAME`, `EXCH`, `PRICE2` (foreign)/`PRICE` (ILS), `PERCENT` (duty%), `PURTAXPERCENT`, `PURTAXADD`, `CUSTOMS` (duty amt) |
| `MANIVDUTIES_SUBFORM` | העמסות ידניות לעלויות | manual cost allocations (empty on auto‑loaded files) |
| `MANIVPARTS2_SUBFORM` | שורות מוצרים נוספות | line‑level linked purchased items |
| `EXPIVDUTIES_SUBFORM` | עלויות צפויות | expected costs (feeds expected/actual report) |
| `GENCUSTNOTES_SUBFORM`, `DOCTODOLIST(LOG)_SUBFORM` | הערות / לוג סטטוסים | notes / status log |
| `EXTFILES_SUBFORM`, `LIBRARY_SUBFORM` | נספחים | attachments |
| `CONTAINERSPLANIMP_SUBFORM` | מכולות | container planning |
| `IMPFILESTEXT_SUBFORM`, `INTERNALDIALOGTEXT_SUBFORM`, `SEARCHDOCVERS_SUBFORM` | טקסט/גרסאות | text / versions |

> **`impfile_get` must aggregate** `IMPFILEINV` + `MANIVDUTIES` + `MANIVPARTS2` + `EXPIVDUTIES`
> + `IMPFILECUSTOMS` + `IMPFILEITEMS` + `IMPFILEPORDI` — line‑level linked costs/items do **not**
> appear inside `IMPFILEINV`, exactly as the spec warns.

---

## 3. Supplier invoices — `PINVOICES`

Form **`PINVOICES`** ("חשבוניות ספק מרכזות"), **composite key** `(IVNUM, DEBIT, IVTYPE)` → single‑value
`get` 404s; **query by `$filter` on `IVNUM`** (same pattern as `AINVOICES`). `DEBIT`='D' (חיוב) /
'C' (זכוי → credit note; **no separate credit form**). `IVTYPE`='P'. `STORNOFLAG` = cancelled/storno.

**File link is at the header:** `IMPFNUM` (תיק יבוא/יצוא) + `OTYPE`='P' (סוג תיק). `PIVDOC_SUBFORM`
(references tab) was **empty** on the real file → linking is via these two header fields, not a
sub‑form. `BOOKNUM` = the supplier's printed invoice number; `FINAL`='Y' when finalized.

Line sub‑form **`PINVOICEITEMS_SUBFORM`**: `PARTNAME`, `PDES`, `TQUANT`, `PRICE`, `QPRICE`,
`TOTPRICE`, `CODE`, `VATFLAG` (Y = taxable), `SPECIALVATFLAG`, `PRSOURCENAME` (`הזמנה`=from PO /
`ידני`=manual), `ORDNAME`, `DOCNO` (=goods‑receipt `GR#`), `SUPPARTNAME`, `ACCNAME`, `EXCH`,
**per‑line `CUSTOMSNUM`/`CUSTOMSDATE`** (declaration per line — present, null in history), `KLINE`.

---

## 4. Purchase orders + 3‑way match — `PORDERS`

Form **`PORDERS`** ("הזמנות רכש"), key `ORDNAME`. Close flags `CLOSEDBOOL` (סגורה) + `BOOLPCLOSED`
(סגורה חלקית). Header `IMPFNUM`/`OTYPE` link a PO to a file.

**The entire 3‑way match comes from one `PORDERS` expand:**
| Leg | Sub‑form | Key fields |
|---|---|---|
| **Ordered** | `PORDERITEMS_SUBFORM` | `PARTNAME`, `SUPPARTNAME`, `TQUANT` (ordered), `TBALANCE` (remaining), `PRICE`, `CODE`, `CLOSEDBOOL`, `DUTYPERCENTTYPE`, `ORDI`/`KLINE` |
| **Received** | `PORDERTRANS_SUBFORM` | `DOCDES`="קבלות סחורה מספק", `DOCNO`=`GR#`, `PARTNAME`, `TQUANT` (received), `STATDES` |
| **Invoiced** | `PORDERIV_SUBFORM` | `IVDES`="חש. ספק מרכזות", `IVNUM`=`GI#`, `PARTNAME`, `TQUANT` (invoiced) |

`supplied = TQUANT − TBALANCE`. Goods receipts ("קבלות סחורה מספק", `GR#`) are visible **via the
PO** — a standalone receipt entity isn't needed for matching. Match verdicts (matched / qty‑gap /
price‑gap / ordered‑not‑arrived / arrived‑not‑ordered / received‑not‑invoiced) are all computable
from these three legs + the file's invoice lines.

---

## 5. Broker‑invoice recording template (§3.1) — decoded from real data

Real broker invoice `GI25000026` on file `IM25000009` (forwarder שני שרותי מטען):

- **Header:** `PINVOICES` { `SUPNAME`=forwarder, `IVDATE`, `BOOKNUM`=supplier inv#, `CODE`='ש"ח',
  `DEBIT`='D', `OTYPE`='P', `IMPFNUM`=file } → `TOTPRICE` 17 244, `VAT` 11 493.
- **VAT‑from‑declaration line (the system part the spec asked us to locate):**
  **`PARTNAME` = `מע'מ`**, `PDES` = **"סכום המע'מ ברשומון של המכס"**, `TQUANT`=1, `PRICE`=declaration
  VAT amount, `VATFLAG`='Y'. Its amount adds to invoice VAT, not the pre‑VAT sum (§3.1). Line
  carries optional `CUSTOMSNUM`/`CUSTOMSDATE` — **one such line per declaration**.
- **Cost lines** — each a dedicated cost part, `TQUANT`=1, manual `PRICE`, account `502-0`:

  | Part | תאור | VAT? |
  |---|---|---|
  | `AVI001` | הובלה ימית/אווירית | no |
  | `AVI003` | ביטוח | no |
  | `AVI007` | עמילות מכס | yes |
  | `AVI008` | הובלה יבשתית | yes |
  | `AVI012` | אוברסייז | yes |
  | `AVI021` | אגרת נמל/אחסנה | no |
  | `AVI004` | אגרת ביטחון | no |
  | `AVI005` | אגרת מחשב | no |
  | `AVI006` | מיכון | yes |
  | `AVI014` | שער עולמי | yes |
  | `AVI022` | פורמליות | yes |

- **Customs (duty) line:** a dedicated **מכס part with loading method `C`** — **NOT present in this
  company's data** (all files duty‑free, see §6). ⚠️ **Open item:** if duty is ever charged, the
  exact duty part code must be supplied by the user; the tool will accept it as a parameter.

**Goods invoice** (`GI25000025`): `PINVOICES` { foreign `SUPNAME` + `CODE`, `OTYPE`='P', `IMPFNUM`,
`ORDNAME` } with SKU lines priced from the order (`PRSOURCENAME`='הזמנה', `DOCNO`=`GR#`).

---

## 5b. Slice-2 write facts (verified 2026-07-18)

- **VAT-from-declaration part** exists and is exact: `PARTNAME="מע'מ"` (ASCII apostrophe U+0027),
  `PARTDES="סכום המע'מ ברשומון של המכס"`, `TYPE='O'`, `STATDES='אסור למכירה'`. Safe to hardcode as the
  default in `pinvoice_create` (broker mode); overridable by param.
- **Cost parts** are real `TYPE='R'` parts (e.g. `AVI001` הובלה ימית/אווירית, `AVI007` עמילות מכס).
- **`MANIVDUTIES` / `EXPIVDUTIES` / `MANIVPARTS2` are EMPTY on ALL 114 files** — this company has
  never used manual cost allocations, expected costs, or extra product lines (automatic loading only).
  ⇒ `impfile_manual_alloc` and `impfile_expected_costs` are **coded-not-observed**: they accept a
  `fields` object and POST it to the sub-form, with the exact line-field names flagged unverified
  (no live example exists; confirm against a real allocation or the form's $metadata before real use).
- **`PINVOICES` composite key** `(IVNUM,DEBIT,IVTYPE)` means retro-linking an existing invoice needs a
  composite-key PATCH — added `client.resolveCompositeUrl`/`updateComposite`. Create (POST to the
  collection) needs no key. The per-line and final-invoice link routes need the "חשבוניות לתיקי יבוא" /
  "עדכון פרטים לחשבוניות ספק" screens, whose OData entities are not yet mapped (open item).

## 6. Customs computation model (§3.2 / §3.3)

- **`CUSTOMSITEMS`** ("פריטי מכס"), key `CUSTOMSITEMNAME`: `PERCENT` (% מכס כללי), `PERCENT1`
  (% הקהילה/EU), `PERCENT2` (% צפ' אמריקה), `PURTAXPERCENT` (מס קניה), `PURTAXADD` (% תוספות),
  + `CUSTOMSCOUNTRY_SUBFORM` (special per‑country rates).
- **`COUNTRIES.CUSTOMSTYPE`** ("סווג למכס") selects which duty column applies (general / EU / N.America).
- Per §3.3: `duty = duty% × price`; `purchase_tax = purtax% × (1 + additions%) × (price + duty)`.
- A part with **no** customs item bears **no** duty (§3.2). **In this company every part sampled has
  `CUSTOMSITEMNAME = null` and `CUSTOMS = 0`** (US & Korea origins) → their imports are effectively
  duty‑free today. The duty logic will be coded per spec but is **coded‑not‑observed** here.

---

## 7. FX basis (§3.4)

- Ancillary‑cost invoices: FX at invoice date (`EXCH` on the invoice line, e.g. 3.553).
- Purchase (goods) invoices: governed by constant **`ImpFileDates`** (1 = invoice date, 0 = stock‑
  receipt date). **`FNCCONST` data is API‑blocked** → value not readable; the tool defaults to the
  Priority default and states the assumption (user can override). Changing the constant doesn't
  affect a closed file → reopen → recalc → reclose.

---

## 8. Procedures — calc / close / reopen / update‑PO‑lines

**Not yet confirmed as OData actions.** `GetMetadataFor` doesn't enumerate bound actions, and full
`$metadata` is too large to fetch reliably. Priority "programs/procedures" (חישוב העמסה, סגירת תיק,
ביטול סגירה) are commonly **UI‑only**, not OData‑exposed. Plan:
- **Verify in Slice 3** with a dry‑run `PATCH` probe (e.g. `IMPFILES(key)` `STATDES`/`CLOSED`) and a
  search for bound actions.
- **Fallback (spec §0):** the tool guides the user to run the procedure in the Priority screen, then
  **verifies the result by reading back** (`CLOSED`='Y', recalculated cost fields). This is the
  default assumption until proven otherwise.

---

## 9. Bonded warehouse (Phase 5) — investigation result

- `IMPFILES.WARHSNAME` is titled **"מחסן ערובה"** and **all 30 files use `arov`** → strong evidence
  this business operates through a bonded warehouse.
- **But** `WAREHOUSES` is data‑blocked, so the type‑D + bonded flag can't be confirmed via API, and
  the bonded **receipt→release procedures** (LBI2400656) are almost certainly UI‑only.
- **DECIDED (2026‑07‑18): the two‑step bonded flow IS used** (receive into `arov` → release against
  a rishumon). ⇒ the bonded tools (§Phase 5) are **in scope**, built as **read + UI‑guided +
  read‑back verify** (bonded procedures aren't API‑writable).
- **CONFIRMED live (2026‑07‑18): `WAREHOUSES` is now queryable** and `arov` is a **type‑D bonded**
  warehouse (`WARHSDES`="ערובה") with TWO locations: **`0`** = bonded holding (`BONDED='Y'`,
  `COSTFLAG=null` → excluded from inventory value) and **`arova`** = costed/released (`COSTFLAG='Y'`,
  `COSTTRANSFLAG='Y'`). Read‑back for the bonded tools uses `WAREHOUSES` config +
  `IMPFILES.IMPFILEITEMS_SUBFORM.TBALANCE` (unreleased qty) + `CLOSED`. `PARTBAL` remains API‑blocked.

---

## 10. Tool → operation plan (14 core tools)

| # | Tool | Primary OData operation |
|---|---|---|
| 1 | `impfile_search` | `GET IMPFILES?$filter=…` (status/supplier/PO/declaration/date) |
| 2 | `impfile_get` | `GET IMPFILES(key)?$expand=` all 7 sub‑forms (§2) |
| 3 | `impfile_open` | `POST IMPFILES` (header) |
| 4 | `impfile_update` | `PATCH IMPFILES(key)` |
| 5 | `pinvoice_create` | `POST PINVOICES` deep‑insert (`PINVOICEITEMS_SUBFORM`) — goods & broker modes (§5) |
| 6 | `impfile_link_invoice` | `PATCH PINVOICES(key)` set `IMPFNUM`+`OTYPE`='P' (+ retro / per‑line / final routes) |
| 7 | `impfile_manual_alloc` | `POST …/MANIVDUTIES_SUBFORM` (cost) or `MANIVPARTS2_SUBFORM` (item) |
| 8 | `po_match` | `GET PORDERS(key)?$expand=PORDERITEMS,PORDERTRANS,PORDERIV` + file invoices (§4) |
| 9 | `po_close_lines` | `PATCH PORDERITEMS`/`PORDERS` close flags (procedure‑gated — verify §8) |
| 10 | `impfile_run_calc` | procedure or UI‑guided + read‑back (§8) |
| 11 | `impfile_close` / `impfile_reopen` | `PATCH` / procedure + read‑back; blocked unless preflight clean |
| 12 | `impfile_landed_cost` | read Priority result post‑calc; self‑compute fallback from §5/§6 logic |
| 13 | `impfile_preflight` | 8 checks (§3.7); checks 1 (loading method) advisory — see §1 |
| 14 | `impfile_expected_costs` | `POST …/EXPIVDUTIES_SUBFORM` |

All writes: `dryRun`/`confirm` default‑safe; server stays `PRIORITY_READ_ONLY=true`; **no real
writes during build** — payloads validated by dry‑run only, with a hand‑over runbook for the real
cycle (per your "dry‑run only on live" decision).

---

## 11. Open items

**Decided (2026‑07‑18):**
- ✅ **Bonded flow** — two‑step receive→release IS used → bonded module in scope (§9).
- ✅ **Duty** — imports are effectively duty‑free → duty path is **coded‑not‑observed**; preflight
  customs‑item check stays advisory (§5, §6).

**Still open (do not block Slices 1–2):**
1. **Procedure exposure** — confirm calc/close/reopen as OData actions vs UI‑fallback (§8, Slice 3).
2. **`ImpFileDates` value** — not API‑readable; default to invoice‑date basis, confirm with user (§7).
3. **Loading‑method form** — "הגדרות כספים למוצרים" not API‑exposed; enable it + get its form name, else
   preflight check §3.7.1 stays advisory (§1, §1b).
4. **Duty part code** — only needed if a dutiable import ever arises (§5).
5. **`WAREHOUSES` data** — enable (Tier‑1) to confirm `arov` bonded flags for the bonded module (§1b, §9).
