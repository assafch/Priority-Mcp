import type { Config } from '../config.js';
import { toolAllowed } from './capabilities.js';
import { TOOL_DEFINITIONS } from './capability-definitions.js';
export const OPERATIONS_TOOLS = new Set([
  'priority_healthcheck',
  'priority_get_capabilities',
  'priority_resolve_entity',
  'priority_list_customers',
  'priority_get_customer',
  'priority_get_customer_balance',
  'priority_list_products',
  'priority_get_product',
  'priority_get_stock_levels',
  'priority_list_orders',
  'priority_get_order',
  'priority_list_invoices',
  'priority_get_invoice',
  'impfile_get',
  'impfile_preflight',
  'priority_prepare_query',
  'priority_query',
  'priority_get_record',
  'priority_get_entity_metadata',
  'priority_customer_snapshot',
  'priority_order_diagnosis',
  'priority_import_diagnosis',
  'priority_product_sales_by_period',
  'priority_get_open_debts',
  'priority_get_supplier',
]);
export function effectiveTools(profile: 'full' | 'operations', config: Config): string[] {
  return TOOL_DEFINITIONS.filter(
    (d) =>
      toolAllowed(config, d.name) &&
      (profile === 'full' || (OPERATIONS_TOOLS.has(d.name) && d.implementation === 'implemented')),
  ).map((d) => d.name);
}
/** Profile controls discovery only; explicit policy still applies to every component read. */
export function dependenciesAllowed(config: Config, names: string[]): boolean {
  return names.every((name) => toolAllowed(config, name));
}

/** Reviewed complete sentences keep core proof boundaries in discovery, before optional help. */
const operationsSummaries: Record<string, string> = {
  priority_healthcheck:
    'Local configuration check. Backend probe is opt-in, read-only, and returns no business data or credentials.',
  priority_get_capabilities:
    'List implementation, policy and dated read evidence. Refresh is opt-in; read support does not prove writes.',
  priority_resolve_entity:
    'Resolve exact IDs or return candidates for selection. Incomplete absence is not proof of nonexistence. Resolution does not authorize writes.',
  priority_list_customers:
    'Bounded customer list/search. Inspect coverage; incomplete absence does not prove nonexistence.',
  priority_get_customer:
    'Read an exact CUSTNAME. Resolve ambiguous names first; reading a record does not authorize writes.',
  priority_get_customer_balance:
    'Read exact-customer ledger balance and credit. Ledger balances are not bank receipt or clearing proof; inspect observation age.',
  priority_list_products:
    'Bounded product list/search. Inspect source coverage; select exact identity before operational action.',
  priority_get_product:
    'Read an exact PARTNAME. Requested stock expansions are source observations, not a promise of fulfillment.',
  priority_get_stock_levels:
    'Read stock by exact product and warehouse. Inspect observation age; stock is not delivery or fulfillment proof.',
  priority_list_orders:
    'Bounded order list with filters. Inspect paging and source coverage; an ERP order is not carrier delivery proof.',
  priority_get_order:
    'Read an exact ORDNAME with order lines. ERP status is not direct carrier delivery proof.',
  priority_list_invoices:
    'Bounded invoice list. Customer names require unique exact resolution; ledger documents do not prove bank clearing.',
  priority_get_invoice:
    'Read invoice detail using validated identity. Invoice existence is not payment or bank clearing proof.',
  impfile_get:
    'Read one import file and its load-bearing subforms. Missing sources remain unknown; ledger documents do not prove clearing.',
  impfile_preflight:
    'Read-only import pre-close diagnostics. Advisory checks remain unverified; this does not close the file.',
  priority_prepare_query:
    'Prepare a bounded schema-validated read preview. Does not execute the query or a mutation; unknown support remains explicit.',
  priority_query:
    'Advanced read-only OData query. Bound fields and rows; inspect source coverage and observation age before drawing conclusions.',
  priority_get_record:
    'Read exact record identity. Composite keys must be complete; a successful read does not authorize a write.',
  priority_get_entity_metadata:
    'Read scoped schema evidence. Targeted metadata is preferred; full discovery requires explicit fallback permission.',
  priority_customer_snapshot:
    'Read exact customer identity, bounded history and balance under component policy. Ledger balances are not bank receipt or clearing proof.',
  priority_order_diagnosis:
    'Read exact order and ERP shipment sources; request lines explicitly for bounded line state. Component policy applies. Tracking labels are not carrier delivery proof.',
  priority_import_diagnosis:
    'Read one import snapshot under component policy. Missing source rows prevent financial calculations. Landed cost is an estimate, not authoritative costing.',
  priority_product_sales_by_period:
    'Bounded read-only sales report with coverage and observation evidence. Partial scans are not final totals; inspect completeness before acting.',
  priority_get_open_debts:
    'Bounded ledger debt read. Inspect coverage and observation age; ledger debts or receipts do not establish bank clearing.',
  priority_get_supplier:
    'Read exact SUPNAME. Resolve ambiguous names first; a record read does not authorize payments or writes.',
};
export function operationsDescription(name: string, original: string): string {
  return `${operationsSummaries[name] ?? original.split('\n')[0]} Help: priority://tools/${name}; or capability detail by name.`;
}
export function workClassForTool(name: string): import('../runtime/types.js').WorkClass {
  if (
    [
      'priority_list_entities',
      'priority_list_forms',
      'priority_get_entity_metadata',
      'priority_get_entity_schema',
      'priority_describe_form',
    ].includes(name)
  )
    return 'discovery';
  if (/report|revenue|sales_by_period/.test(name)) return 'report';
  if (/discover|metadata|schema/.test(name)) return 'discovery';
  return 'interactive';
}
