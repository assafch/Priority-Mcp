# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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
