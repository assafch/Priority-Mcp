# Priority MCP capability inventory — 2026-10-25

Source-derived status, verified against offline MCP tools/list. This is not proof of tenant availability.

`read-path` = implemented read; `write-path` = guarded write implementation; `guide-only` = instructions without execution; `unavailable-in-code` = unconditional refusal. Per-form and procedure limitations still apply to implemented paths.

Counts: {"tools":102,"resources":2,"templates":1,"prompts":5,"byStatus":{"unavailable-in-code":24,"write-path":21,"read-path":52,"guide-only":5}}

| Tool | Code status | Source |
| --- | --- | --- |
| `priority_create_activity` | unavailable-in-code | src/tools/activities.ts:72 |
| `priority_get_customer_activities` | unavailable-in-code | src/tools/activities.ts:42 |
| `priority_get_open_tasks` | unavailable-in-code | src/tools/activities.ts:54 |
| `priority_list_activities` | unavailable-in-code | src/tools/activities.ts:28 |
| `priority_schedule_followup` | unavailable-in-code | src/tools/activities.ts:92 |
| `priority_create_customer` | write-path | src/tools/customers.ts:342 |
| `priority_get_customer` | read-path | src/tools/customers.ts:144 |
| `priority_get_customer_aging` | unavailable-in-code | src/tools/customers.ts:322 |
| `priority_get_customer_balance` | read-path | src/tools/customers.ts:200 |
| `priority_get_customer_contacts` | read-path | src/tools/customers.ts:242 |
| `priority_get_customer_documents` | read-path | src/tools/customers.ts:281 |
| `priority_get_customer_price_list` | read-path | src/tools/customers.ts:263 |
| `priority_list_customers` | read-path | src/tools/customers.ts:43 |
| `priority_search_customers` | read-path | src/tools/customers.ts:174 |
| `priority_update_customer` | write-path | src/tools/customers.ts:384 |
| `priority_get_aging_report` | unavailable-in-code | src/tools/debts.ts:70 |
| `priority_get_open_debts` | read-path | src/tools/debts.ts:13 |
| `priority_get_overdue_invoices` | unavailable-in-code | src/tools/debts.ts:90 |
| `priority_get_payment_history` | unavailable-in-code | src/tools/debts.ts:113 |
| `priority_get_top_debtors` | read-path | src/tools/debts.ts:132 |
| `priority_mark_invoice_disputed` | unavailable-in-code | src/tools/debts.ts:187 |
| `priority_record_payment_promise` | unavailable-in-code | src/tools/debts.ts:163 |
| `priority_get_attachment_url` | read-path | src/tools/documents.ts:118 |
| `priority_list_attachments` | read-path | src/tools/documents.ts:51 |
| `priority_upload_attachment` | write-path | src/tools/documents.ts:190 |
| `priority_get_ap_aging_summary` | unavailable-in-code | src/tools/finance.ts:268 |
| `priority_get_ar_aging_summary` | unavailable-in-code | src/tools/finance.ts:252 |
| `priority_get_bank_balances` | read-path | src/tools/finance.ts:21 |
| `priority_get_cash_position` | read-path | src/tools/finance.ts:84 |
| `priority_get_cashflow_projection` | unavailable-in-code | src/tools/finance.ts:281 |
| `priority_get_revenue_by_period` | read-path | src/tools/finance.ts:127 |
| `priority_get_top_customers` | read-path | src/tools/finance.ts:181 |
| `priority_get_top_products` | unavailable-in-code | src/tools/finance.ts:231 |
| `priority_add_line` | write-path | src/tools/generic.ts:321 |
| `priority_create_record` | write-path | src/tools/generic.ts:247 |
| `priority_describe_form` | read-path | src/tools/generic.ts:113 |
| `priority_get_entity_metadata` | read-path | src/tools/generic.ts:79 |
| `priority_get_record` | read-path | src/tools/generic.ts:215 |
| `priority_list_forms` | read-path | src/tools/generic.ts:19 |
| `priority_query` | read-path | src/tools/generic.ts:149 |
| `priority_update_record` | write-path | src/tools/generic.ts:289 |
| `impfile_close` | write-path | src/tools/impfiles.ts:983 |
| `impfile_expected_costs` | write-path | src/tools/impfiles.ts:807 |
| `impfile_get` | read-path | src/tools/impfiles.ts:418 |
| `impfile_landed_cost` | read-path | src/tools/impfiles.ts:898 |
| `impfile_link_invoice` | write-path | src/tools/impfiles.ts:673 |
| `impfile_manual_alloc` | write-path | src/tools/impfiles.ts:773 |
| `impfile_open` | write-path | src/tools/impfiles.ts:451 |
| `impfile_preflight` | read-path | src/tools/impfiles.ts:878 |
| `impfile_reopen` | write-path | src/tools/impfiles.ts:1026 |
| `impfile_run_calc_guide` | guide-only | src/tools/impfiles.ts:951 |
| `impfile_search` | read-path | src/tools/impfiles.ts:362 |
| `impfile_update` | write-path | src/tools/impfiles.ts:494 |
| `pinvoice_create` | write-path | src/tools/impfiles.ts:535 |
| `po_close_lines` | write-path | src/tools/impfiles.ts:919 |
| `po_match` | read-path | src/tools/impfiles.ts:840 |
| `bonded_fill_detail_guide` | guide-only | src/tools/impfiles-bonded.ts:116 |
| `bonded_line_costs_guide` | guide-only | src/tools/impfiles-bonded.ts:177 |
| `bonded_receipt_guide` | guide-only | src/tools/impfiles-bonded.ts:85 |
| `bonded_release_guide` | guide-only | src/tools/impfiles-bonded.ts:143 |
| `bonded_status` | read-path | src/tools/impfiles-bonded.ts:48 |
| `priority_create_credit_memo` | write-path | src/tools/invoices.ts:279 |
| `priority_create_invoice` | write-path | src/tools/invoices.ts:201 |
| `priority_get_invoice` | read-path | src/tools/invoices.ts:92 |
| `priority_get_unpaid_invoices_for_customer` | read-path | src/tools/invoices.ts:127 |
| `priority_list_invoices` | read-path | src/tools/invoices.ts:16 |
| `priority_void_invoice` | unavailable-in-code | src/tools/invoices.ts:254 |
| `priority_execute_odata_query` | read-path | src/tools/meta.ts:212 |
| `priority_get_current_user` | read-path | src/tools/meta.ts:159 |
| `priority_get_entity_schema` | read-path | src/tools/meta.ts:90 |
| `priority_list_companies` | read-path | src/tools/meta.ts:121 |
| `priority_list_entities` | read-path | src/tools/meta.ts:36 |
| `priority_cancel_order` | write-path | src/tools/orders.ts:231 |
| `priority_confirm_order` | unavailable-in-code | src/tools/orders.ts:261 |
| `priority_create_order` | write-path | src/tools/orders.ts:155 |
| `priority_get_backorder_report` | read-path | src/tools/orders.ts:130 |
| `priority_get_order` | read-path | src/tools/orders.ts:54 |
| `priority_get_order_shipment_status` | read-path | src/tools/orders.ts:104 |
| `priority_get_pending_orders` | read-path | src/tools/orders.ts:75 |
| `priority_list_orders` | read-path | src/tools/orders.ts:15 |
| `priority_update_order` | write-path | src/tools/orders.ts:198 |
| `priority_adjust_stock` | unavailable-in-code | src/tools/products.ts:325 |
| `priority_get_low_stock_alerts` | unavailable-in-code | src/tools/products.ts:180 |
| `priority_get_out_of_stock` | unavailable-in-code | src/tools/products.ts:199 |
| `priority_get_product` | read-path | src/tools/products.ts:98 |
| `priority_get_product_price` | read-path | src/tools/products.ts:218 |
| `priority_get_product_sales_history` | unavailable-in-code | src/tools/products.ts:272 |
| `priority_get_stock_levels` | read-path | src/tools/products.ts:144 |
| `priority_list_products` | read-path | src/tools/products.ts:19 |
| `priority_search_products` | read-path | src/tools/products.ts:119 |
| `priority_transfer_stock` | unavailable-in-code | src/tools/products.ts:352 |
| `priority_update_product_price` | unavailable-in-code | src/tools/products.ts:295 |
| `priority_create_purchase_order` | write-path | src/tools/purchase-orders.ts:98 |
| `priority_get_incoming_shipments` | read-path | src/tools/purchase-orders.ts:72 |
| `priority_get_purchase_order` | read-path | src/tools/purchase-orders.ts:53 |
| `priority_list_purchase_orders` | read-path | src/tools/purchase-orders.ts:19 |
| `priority_product_sales_by_period` | read-path | src/tools/sales-report.ts:85 |
| `priority_get_supplier` | read-path | src/tools/suppliers.ts:86 |
| `priority_get_supplier_balance` | unavailable-in-code | src/tools/suppliers.ts:105 |
| `priority_list_suppliers` | read-path | src/tools/suppliers.ts:13 |
| `priority_search_suppliers` | read-path | src/tools/suppliers.ts:53 |
| `priority_list_warehouses` | read-path | src/tools/warehouses.ts:12 |

## Resources and prompts

- Resource: `priority://company/info`
- Resource: `priority://user/profile`
- Template: `priority://schema/{entity}`
- Prompt: `debt_collection_workflow`
- Prompt: `daily_briefing`
- Prompt: `cash_position_summary`
- Prompt: `order_fulfillment_check`
- Prompt: `inventory_reorder_check`
