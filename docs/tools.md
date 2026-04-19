# Tool Reference

priority-mcp-server exposes **72 tools** across 12 domains.

## Customers (10 tools)

| Tool | Description |
|------|-------------|
| `priority_list_customers` | List customers with optional filters (status, sales rep, min balance) |
| `priority_get_customer` | Get a single customer by customer number |
| `priority_search_customers` | Fuzzy search by name, tax ID, phone, or email |
| `priority_get_customer_balance` | Get a customer's open AR balance |
| `priority_get_customer_contacts` | List contacts — names, phones, emails, roles |
| `priority_get_customer_price_list` | Get assigned price list and discount rules |
| `priority_get_customer_documents` | List all documents (invoices, orders, quotes) |
| `priority_get_customer_aging` | Get aging buckets (0-30, 31-60, 61-90, 90+ days) |
| `priority_create_customer` | Create a new customer |
| `priority_update_customer` | Update an existing customer |

## Orders (9 tools)

| Tool | Description |
|------|-------------|
| `priority_list_orders` | List sales orders with optional filters |
| `priority_get_order` | Get a single order with line items |
| `priority_get_pending_orders` | Get orders awaiting fulfillment |
| `priority_get_order_shipment_status` | Get shipment/tracking info for an order |
| `priority_get_backorder_report` | Get orders with out-of-stock/backordered items |
| `priority_create_order` | Create a new sales order |
| `priority_update_order` | Update header fields or line items |
| `priority_cancel_order` | Cancel an order with a reason |
| `priority_confirm_order` | Confirm/approve a sales order |

## Products (11 tools)

| Tool | Description |
|------|-------------|
| `priority_list_products` | List products/parts with optional filters |
| `priority_get_product` | Get full product details (cost, prices, stock, suppliers) |
| `priority_search_products` | Search by name, SKU, or barcode |
| `priority_get_stock_levels` | Get stock levels across all warehouses |
| `priority_get_low_stock_alerts` | Get products below reorder point |
| `priority_get_out_of_stock` | Get products with zero stock |
| `priority_get_product_price` | Get price, optionally for a specific customer |
| `priority_get_product_sales_history` | Get sales velocity over recent periods |
| `priority_update_product_price` | Update the list price |
| `priority_adjust_stock` | Adjust stock level with a reason code |
| `priority_transfer_stock` | Transfer stock between warehouses |

## Invoices (6 tools)

| Tool | Description |
|------|-------------|
| `priority_list_invoices` | List invoices with optional filters |
| `priority_get_invoice` | Get a single invoice with line items |
| `priority_get_unpaid_invoices_for_customer` | Get all unpaid invoices for a customer |
| `priority_create_invoice` | Create a new invoice |
| `priority_void_invoice` | Void/cancel an invoice |
| `priority_create_credit_memo` | Issue a credit memo against an invoice |

## Debts / AR (7 tools)

| Tool | Description |
|------|-------------|
| `priority_get_open_debts` | Get all open accounts receivable debts |
| `priority_get_aging_report` | Company-wide aging summary with customer breakdown |
| `priority_get_overdue_invoices` | Past-due invoices sorted by days overdue |
| `priority_get_payment_history` | Customer payment behavior — avg days to pay |
| `priority_get_top_debtors` | Top N customers by open debt amount |
| `priority_record_payment_promise` | Record a customer's promise-to-pay date |
| `priority_mark_invoice_disputed` | Flag an invoice as disputed with a reason |

## Finance (8 tools)

| Tool | Description |
|------|-------------|
| `priority_get_bank_balances` | Current balances for all bank accounts |
| `priority_get_cash_position` | Net cash position across all accounts |
| `priority_get_revenue_by_period` | Revenue breakdown by period |
| `priority_get_top_customers` | Top customers by revenue for a period |
| `priority_get_top_products` | Top-selling products by revenue for a period |
| `priority_get_ar_aging_summary` | AR aging summary across all customers |
| `priority_get_ap_aging_summary` | AP aging summary across all suppliers |
| `priority_get_cashflow_projection` | Cashflow projection — upcoming AR vs AP |

## Purchase Orders (4 tools)

| Tool | Description |
|------|-------------|
| `priority_list_purchase_orders` | List POs with optional filters |
| `priority_get_purchase_order` | Get a single PO with line items |
| `priority_get_incoming_shipments` | Get POs in transit / expected to arrive |
| `priority_create_purchase_order` | Create a new purchase order |

## Suppliers (3 tools)

| Tool | Description |
|------|-------------|
| `priority_list_suppliers` | List suppliers with optional filters |
| `priority_get_supplier` | Get full supplier record by SUPNAME |
| `priority_get_supplier_balance` | Get open AP balance for a supplier |

## Warehouses (1 tool)

| Tool | Description |
|------|-------------|
| `priority_list_warehouses` | List all warehouses in the system |

## Activities / CRM (5 tools)

| Tool | Description |
|------|-------------|
| `priority_list_activities` | List CRM activities (calls, meetings, tasks) |
| `priority_get_customer_activities` | Get full activity history for a customer |
| `priority_get_open_tasks` | Get open/pending tasks |
| `priority_create_activity` | Log a new CRM activity against a customer |
| `priority_schedule_followup` | Schedule a future follow-up task |

## Documents (3 tools)

| Tool | Description |
|------|-------------|
| `priority_list_attachments` | List file attachments for any entity |
| `priority_get_attachment_url` | Get download URL for an attachment |
| `priority_upload_attachment` | Upload/attach a file to an entity |

## Meta / Schema (5 tools)

| Tool | Description |
|------|-------------|
| `priority_list_entities` | List all available entities (tables/forms) |
| `priority_get_entity_schema` | Get field list and types for an entity |
| `priority_list_companies` | List all companies in the environment |
| `priority_get_current_user` | Get current API user info |
| `priority_execute_odata_query` | Execute a raw OData query against any entity |
