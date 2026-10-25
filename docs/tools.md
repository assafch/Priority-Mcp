# Tool capabilities — 0.2.0

This catalog describes code, not current tenant permissions. Use `priority_get_capabilities` for policy and dated form-readability evidence; follow `nextSkip`. A successful form probe does not enable an unavailable handler or prove a write.

105 registered definitions. Existing tool names remain available subject to allow/block policy. Every tool has risk annotations and an object output schema; JSON text and structured content agree.

| Tool | Domain | Mode | Implementation |
| --- | --- | --- | --- |
| `priority_create_activity` | activities | write | unavailable |
| `priority_get_customer_activities` | activities | read | unavailable |
| `priority_get_open_tasks` | activities | read | unavailable |
| `priority_list_activities` | activities | read | unavailable |
| `priority_schedule_followup` | activities | write | unavailable |
| `priority_create_customer` | customers | write | implemented |
| `priority_get_customer` | customers | read | implemented |
| `priority_get_customer_aging` | customers | read | unavailable |
| `priority_get_customer_balance` | customers | read | implemented |
| `priority_get_customer_contacts` | customers | read | implemented |
| `priority_get_customer_documents` | customers | read | implemented |
| `priority_get_customer_price_list` | customers | read | implemented |
| `priority_list_customers` | customers | read | implemented |
| `priority_search_customers` | customers | read | implemented |
| `priority_update_customer` | customers | write | implemented |
| `priority_get_aging_report` | debts | read | unavailable |
| `priority_get_open_debts` | debts | read | implemented |
| `priority_get_overdue_invoices` | debts | read | unavailable |
| `priority_get_payment_history` | debts | read | unavailable |
| `priority_get_top_debtors` | debts | read | implemented |
| `priority_mark_invoice_disputed` | debts | write | unavailable |
| `priority_record_payment_promise` | debts | write | unavailable |
| `priority_get_attachment_url` | documents | read | implemented |
| `priority_list_attachments` | documents | read | implemented |
| `priority_upload_attachment` | documents | write | implemented |
| `priority_get_ap_aging_summary` | finance | read | unavailable |
| `priority_get_ar_aging_summary` | finance | read | unavailable |
| `priority_get_bank_balances` | finance | read | implemented |
| `priority_get_cash_position` | finance | read | implemented |
| `priority_get_cashflow_projection` | finance | read | unavailable |
| `priority_get_revenue_by_period` | finance | read | implemented |
| `priority_get_top_customers` | finance | read | implemented |
| `priority_get_top_products` | finance | read | unavailable |
| `priority_add_line` | generic | write | implemented |
| `priority_create_record` | generic | write | implemented |
| `priority_describe_form` | generic | read | implemented |
| `priority_get_entity_metadata` | generic | read | implemented |
| `priority_get_record` | generic | read | implemented |
| `priority_list_forms` | generic | read | implemented |
| `priority_query` | generic | read | implemented |
| `priority_update_line` | generic | write | implemented |
| `priority_update_record` | generic | write | implemented |
| `impfile_close` | impfiles | write | implemented |
| `impfile_expected_costs` | impfiles | write | implemented |
| `impfile_get` | impfiles | read | implemented |
| `impfile_landed_cost` | impfiles | read | implemented |
| `impfile_link_invoice` | impfiles | write | implemented |
| `impfile_manual_alloc` | impfiles | write | implemented |
| `impfile_open` | impfiles | write | implemented |
| `impfile_preflight` | impfiles | read | implemented |
| `impfile_reopen` | impfiles | write | implemented |
| `impfile_run_calc_guide` | impfiles | guide | implemented |
| `impfile_search` | impfiles | read | implemented |
| `impfile_update` | impfiles | write | implemented |
| `pinvoice_create` | impfiles | write | implemented |
| `po_close_lines` | impfiles | write | implemented |
| `po_match` | impfiles | read | implemented |
| `bonded_fill_detail_guide` | impfiles-bonded | guide | implemented |
| `bonded_line_costs_guide` | impfiles-bonded | guide | implemented |
| `bonded_receipt_guide` | impfiles-bonded | guide | implemented |
| `bonded_release_guide` | impfiles-bonded | guide | implemented |
| `bonded_status` | impfiles-bonded | read | implemented |
| `priority_create_credit_memo` | invoices | write | implemented |
| `priority_create_invoice` | invoices | write | implemented |
| `priority_get_invoice` | invoices | read | implemented |
| `priority_get_unpaid_invoices_for_customer` | invoices | read | implemented |
| `priority_list_invoices` | invoices | read | implemented |
| `priority_void_invoice` | invoices | write | unavailable |
| `priority_execute_odata_query` | meta | read | implemented |
| `priority_get_capabilities` | meta | read | implemented |
| `priority_get_current_user` | meta | read | implemented |
| `priority_get_entity_schema` | meta | read | implemented |
| `priority_healthcheck` | meta | read | implemented |
| `priority_list_companies` | meta | read | implemented |
| `priority_list_entities` | meta | read | implemented |
| `priority_cancel_order` | orders | write | implemented |
| `priority_confirm_order` | orders | write | unavailable |
| `priority_create_order` | orders | write | implemented |
| `priority_get_backorder_report` | orders | read | implemented |
| `priority_get_order` | orders | read | implemented |
| `priority_get_order_shipment_status` | orders | read | implemented |
| `priority_get_pending_orders` | orders | read | implemented |
| `priority_list_orders` | orders | read | implemented |
| `priority_update_order` | orders | write | implemented |
| `priority_adjust_stock` | products | write | unavailable |
| `priority_get_low_stock_alerts` | products | read | unavailable |
| `priority_get_out_of_stock` | products | read | unavailable |
| `priority_get_product` | products | read | implemented |
| `priority_get_product_price` | products | read | implemented |
| `priority_get_product_sales_history` | products | read | unavailable |
| `priority_get_stock_levels` | products | read | implemented |
| `priority_list_products` | products | read | implemented |
| `priority_search_products` | products | read | implemented |
| `priority_transfer_stock` | products | write | unavailable |
| `priority_update_product_price` | products | write | unavailable |
| `priority_create_purchase_order` | purchase-orders | write | implemented |
| `priority_get_incoming_shipments` | purchase-orders | read | implemented |
| `priority_get_purchase_order` | purchase-orders | read | implemented |
| `priority_list_purchase_orders` | purchase-orders | read | implemented |
| `priority_product_sales_by_period` | sales-report | read | implemented |
| `priority_get_supplier` | suppliers | read | implemented |
| `priority_get_supplier_balance` | suppliers | read | unavailable |
| `priority_list_suppliers` | suppliers | read | implemented |
| `priority_search_suppliers` | suppliers | read | implemented |
| `priority_list_warehouses` | warehouses | read | implemented |

## Key and result contracts

Generic get/update/add-line and attachment tools support validated simple or composite keys. Supply exactly one of `key` or `keys` (attachment tools retain `entityKey` for legacy simple keys). `priority_update_line` updates a validated subform row. Write tools default to preview and preserve read-only policy.

Write status separates preview, blocked, verified, unverified, unknown and failed. An acknowledgment is not business completion. Partial scans expose completeness and continuation; bounded results remain valid JSON with omission metadata. Five guide tools do not execute Priority procedures. Twenty-four legacy tools still require validated tenant mappings or procedures.

## Discovery examples

```json
{"domain":"invoices","includeUnavailable":true,"refresh":false,"top":25,"skip":0}
```

Call `priority_healthcheck` without arguments for local diagnostics, or set `checkBackend:true` for a read-only backend check. No diagnostic tool mutates ERP data.
