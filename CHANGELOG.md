# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
