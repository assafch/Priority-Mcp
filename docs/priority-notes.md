# Priority OData Quirks and Notes

This document covers Priority ERP-specific OData behaviors that differ from standard OData conventions.

## URL Structure

Priority's OData endpoint follows this pattern:

```
https://<server>/odata/Priority/tabula.ini/<environment>/<company>/<entity>
```

- `tabula.ini` is always present in the URL path.
- `environment` is the Priority environment name (e.g., `wlnd`).
- `company` is the company name within that environment (e.g., `demodata`).

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
- Use `substringof('value', FIELD)` for contains searches (not `contains()`).
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
