# Priority OData Quirks and Notes

This document covers Priority ERP-specific OData behaviors that differ from standard OData conventions.

## URL Structure

Priority's OData endpoint follows this **official** pattern (OData v4):

```
https://<server>/odata/Priority/<env>[,<langcode>]/<company>/<entity>
```

- `<env>` is the system database `.ini` segment — **almost always `tabula.ini`**. It is NOT a
  separate "environment name". The optional `,<langcode>` (a Priority-specific, install-dependent
  numeric code) sets the language of system messages.
- `<company>` is the company database (e.g., `demodata`).
- There is **no** extra environment path segment before `/odata/Priority`.

This server assembles the root as `{PRIORITY_API_URL}/{PRIORITY_ENVIRONMENT}/{PRIORITY_COMPANY}`,
so with `PRIORITY_API_URL=https://srv/odata/Priority`, `PRIORITY_ENVIRONMENT=tabula.ini`,
`PRIORITY_COMPANY=demodata` you get `https://srv/odata/Priority/tabula.ini/demodata`.

> ⚠️ If your installation's working URL differs from this, set the full root in
> `PRIORITY_SERVICE_ROOT` (it overrides the three parts). Always sanity-check the root against a
> URL that works in a browser/curl — the exact path varies between Cloud and on-prem installs.

## Verify against live metadata (do not assume)

A few names in this file and in the domain tools are **installation-dependent and must be
confirmed** via `priority_list_forms` / `priority_get_entity_metadata` (or `priority_describe_form`)
before relying on them:

- **Credit-invoice form**: there is no universal name. The domain `priority_create_credit_memo`
  tool guesses `CINVOICES`; your install may differ. Confirm the real form (and its line sub-form)
  before crediting.
- **Sub-form (navigation-property) names**: this doc lists `ORDERITEMS` / `AINVOICEITEMS`, while
  some domain tools use the `*_SUBFORM` suffix (e.g. `AINVOICEITEMS_SUBFORM`). The exact name comes
  from `$metadata` / `GetMetadataFor` — check it per form.
- **Customer name field**: this doc lists `CDES`; standard Priority uses `CUSTDES`. Confirm which
  your install exposes.

### Verified live — company `a051014` (server `p.priority-connect.online`, `tabp008h.ini`)

Confirmed against `GetMetadataFor` + bounded reads on 2026-06-01 (read-only):

| Form | Title (he) | Key | Name field | Line sub-form |
|------|-----------|-----|------------|---------------|
| `CUSTOMERS` | לקוחות | `CUSTNAME` (string) | `CUSTDES` | — |
| `ORDERS` | — | `ORDNAME` (string) | — | `ORDERITEMS_SUBFORM` |
| `AINVOICES` | חשבוניות מס (tax invoices) | composite `IVNUM,DEBIT,IVTYPE` | `CDES` | `AINVOICEITEMS_SUBFORM` |

- **Credit invoices (חשבונית מס זיכוי)**: created in **`AINVOICES` with NEGATIVE quantities/amounts**
  (verified: AINVOICES holds credit docs such as `IK26000035` with `TOTPRICE` −1090). There is **no**
  dedicated credit form here.
- **`CINVOICES` is "חשבוניות מרכזות" (consolidated invoices), NOT credit memos.** Other letter forms:
  `BINVOICES`=הפקדות מקופה, `DINVOICES`=חשבוניות עסקה מספק, `EINVOICES`=חשבוניות מס קבלה,
  `FINVOICES`=חשבוניות חו"ל, `RINVOICES`=חשבוניות עסקה, `TINVOICES`=קבלות, `YINVOICES`=חשבוניות ספק.
- **Composite invoice key**: a single-value key predicate (e.g. `AINVOICES('IV123')`) will 404 — invoice
  forms are keyed by `(IVNUM,DEBIT,IVTYPE)`. Use `priority_query` with a `$filter` on `IVNUM` instead of
  `priority_get_record` for invoices.
- **`GetMetadataFor(entity='X')` is fast (~1s) and returns CSDL XML with Hebrew titles + mandatory flags;**
  the full `$metadata` document and the service root (`list_forms`, ~1371 forms) are slow (60–90s) on this
  large install — prefer `GetMetadataFor`/`describe_form` for a known form, and expect `list_forms` to need
  a longer client timeout.

### Verified live — filtering & field drift (2026-06-01, read-only)

These were confirmed by live queries and drive `src/lib/priority-schema.ts`, `src/lib/search.ts`,
and `src/lib/dates.ts`:

- **OData string functions are UNSUPPORTED here.** `contains(...)` and `startswith(...)` return
  **HTTP 501 "Function … is not supported"**. The search tools (`priority_search_customers`,
  `priority_search_products`) and the `search` params now try `contains()` once, then fall back to
  fetching a projected page and matching in-process; the verdict is memoized per process.
- **Date columns reject bare dates.** `IVDATE`/`CURDATE`/`PAYDATE` are `Edm.DateTimeOffset`;
  `IVDATE ge 2026-05-01` → **400 "Invalid DateTimeOffset format"**. Use a full literal
  (`2026-05-01T00:00:00Z`). `src/lib/dates.ts` expands date-only inputs (start-of-day for range
  starts, end-of-day for range ends) before they reach a `$filter`.
- **AINVOICES has NO `CURDATE`** — the invoice date is **`IVDATE`**. (This silently broke every
  invoice date filter/sort.) ORDERS and PORDERS *do* have `CURDATE`.
- **Field drift vs. the generic domain tools (fields that DO NOT exist on this install):**
  `CUSTOMERS.SNAME` (use `AGENTNAME`), `CUSTOMERS.CUSTBALANCE`/`CREDITLIMIT`, `SUPPLIERS.SUPBALANCE`,
  `LOGPART.INACTIVE`, `ORDERS.STATDES` (use `ORDSTATUSDES`) and `ORDERS.CLOSED` (use `BOOLCLOSED`),
  `PORDERS.EXPIRYDATE`/`CLOSED` (use `CLOSEDBOOL`).
- **Not exposed as top-level OData sets (queries 404):** `ORDERITEMS`, `OPENDEBT`, `SUP_OPENDEBT`.
  Tools that target them (`get_product_sales_history`, `get_top_products`, `get_open_debts`,
  `get_overdue_invoices`, `get_unpaid_invoices_for_customer`, `get_cashflow_projection`) need a
  follow-up to point at exposed forms. `PHONEBOOK` is the **contacts master** (key `FIRMA,NAMEA`),
  not a CRM activities/tasks form, so the activity tools also need rework.
- **Errors now carry self-correcting hints**: a 501 suggests dropping string functions / using the
  search tools; a 400 "Could not find a property named 'X' on type '…FORM'" names the form and
  points at `priority_describe_form`.

### Verified live — drift repoints (2026-06-01, read-only)

Several domain tools targeted forms/fields that don't exist or aren't API-exposed here. Repointed to
the exposed equivalents (live-verified field names), driven by `src/lib/priority-schema.ts`:

| Tool(s) | Was → Now | Key fields used |
|---|---|---|
| `get_customer_balance`, `get_top_debtors` | `CUSTOMERS.CUSTBALANCE` → **`OBLIGO`** | `CREDIT` (balance), `MAX_CREDIT` (limit), `CREDIT_REST` (available) |
| `get_open_debts`, `get_unpaid_invoices_for_customer` | `OPENDEBT` → **`OPENINVOICES`** | amount `TOTPRICE`, date `CURDATE` (no `DEBIT`/`PAYDATE`/`SNAME`) |
| `get_product_sales_history`, finance `get_top_products` | `ORDERITEMS` → **`SALESINVOICEITEMS`** | `PARTNAME`, `IVDATE`, `TQUANT`, `DISPRICE` |
| `get_stock_levels`, `get_out_of_stock` | `LOGCOUNTERS` → **`PARTBAL`** | `BALANCE`/`TBALANCE` per `WARHSNAME` |
| `list_orders` status, `get_pending_orders`, confirm/cancel | `STATDES`/`CLOSED` → **`ORDSTATUSDES`/`BOOLCLOSED`** | — |
| `list_purchase_orders`, `get_incoming_shipments` | `CLOSED`/`EXPIRYDATE` → **`CLOSEDBOOL`** + `CURDATE` | — |
| `list_products` active | `INACTIVE` → **`STATDES` eq/ne `'פעיל'`** | — |
| `list_customers` sales-rep | `SNAME` → **`AGENTNAME`** | — |

**Gracefully degraded** (form not exposed / no equivalent → returns `{available:false, reason, suggestion}`
without hitting the network, instead of a 404): `get_overdue_invoices` (no PAYDATE on OPENINVOICES),
`get_aging_report`/`get_customer_aging`/AR&AP aging summaries (`AGED_BALANCES*` absent),
`get_payment_history` (`PAYMENTHIST` absent), `get_low_stock_alerts` (no reorder-point column),
`get_supplier_balance` (no `SUPBALANCE`/supplier-open form), `get_cashflow_projection`
(`OPENDEBT`/`SUP_OPENDEBT` absent), and all CRM activity tools + `record_payment_promise` (PHONEBOOK is
the contacts master, not an activity log). Each names the candidate form to expose for full support.

## Entity Names

Priority entity names map to internal form/table names, not user-friendly labels:

| Entity | Priority Name | Description |
|--------|---------------|-------------|
| Customers | `CUSTOMERS` | Customer master |
| Orders | `ORDERS` | Sales orders |
| Order Items | `ORDERITEMS` | Sales order lines (sub-entity of ORDERS) |
| Invoices | `AINVOICES` | A/R invoices |
| Invoice Items | `AINVOICEITEMS` | Invoice line items |
| Products | `LOGPART` | Parts/products master |
| Suppliers | `SUPPLIERS` | Supplier/vendor master |
| Purchase Orders | `PORDERS` | Purchase orders |
| Warehouses | `WAREHOUSES` | Warehouse master |
| Activities | `PHONEBOOK` | CRM activities |
| Bank Accounts | `BANKACCOUNTS` | Bank accounts |
| Receipts | `RECEIPTS` | A/R receipts (payments) |

## Sub-Entities (Navigation Properties)

Priority uses sub-forms as OData navigation properties. Access them like:

```
ORDERS('SO24000001')/ORDERITEMS
```

Sub-entities are not directly queryable at the top level. You must go through the parent.

## Field Naming Conventions

- Field names are UPPERCASE (e.g., `CUSTNAME`, `ORDNAME`, `PARTNAME`).
- Date fields use the format `YYYY-MM-DDT00:00:00+00:00` (ISO 8601 with timezone).
- Boolean fields are stored as `Y`/blank (not true/false).
- Status fields use Priority-specific codes (e.g., order status `C` = confirmed).

## Common Field Names

| Field | Meaning |
|-------|---------|
| `CUSTNAME` | Customer number/ID |
| `CDES` | Customer name/description |
| `ORDNAME` | Order number |
| `PARTNAME` | Part/product number |
| `SUPNAME` | Supplier number |
| `IVNUM` | Invoice number |
| `QPRICE` | Quantity price |
| `TQUANT` | Total quantity |
| `SNAME` | Sales rep name |
| `STATDES` | Status description |

## Pagination

Priority supports standard OData `$top` and `$skip`:

```
CUSTOMERS?$top=50&$skip=100
```

There is **no** `$count` support in most Priority installations. The server estimates "has more" by checking if the returned count equals `$top`.

## Filtering Quirks

- String comparisons are **case-sensitive** by default.
- Priority's REST API is OData **v4**, so use `contains(FIELD,'value')` for substring searches
  (the v2/v3 `substringof('value',FIELD)` form is not the v4 standard). This server's tools use
  `contains()`.
- Some fields support `$filter`, others do not. If a filter fails, Priority returns all records.
- Date filtering: `$filter=CURDATE ge 2024-01-01T00:00:00+00:00`

## Write Operations

- **POST** to create new records.
- **PATCH** to update existing records (not PUT).
- Creating a record with sub-entities requires nested JSON.
- Some fields are read-only and will be silently ignored on write.
- After creating an order/invoice, Priority auto-generates the document number. The response includes the generated number.

## Error Handling

- Priority returns HTTP 400 with an `odata.error` object for validation errors.
- Error messages may be in Hebrew or English depending on the user's language setting.
- Connection timeouts are common on large queries; use `$top` to limit result size.

## Custom Entities

Priority installations often have custom screens (prefixed with the customer's letter code, e.g., `ZORD_MYCUSTOMFORM`). Use `PRIORITY_CUSTOM_PREFIX` and `PRIORITY_CUSTOM_ENTITIES` to enable access to these.

## Language

Set `PRIORITY_LANGUAGE=HE` for Hebrew responses. This affects:
- Error messages
- Status descriptions
- Field descriptions in metadata

The default is `EN` (English).
