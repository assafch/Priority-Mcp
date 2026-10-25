import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PriorityClient } from '../client/priority-client.js';
import type { Config } from '../config.js';
import { toolRegistry } from '../lib/tool-registry.js';
import { registerActivityTools } from './activities.js';
import { registerCapabilityTools } from './capabilities.js';
import { registerCustomerTools } from './customers.js';
import { registerDebtTools } from './debts.js';
import { registerDocumentTools } from './documents.js';
import { registerFinanceTools } from './finance.js';
import { registerGenericTools } from './generic.js';
import { registerBondedTools } from './impfiles-bonded.js';
import { registerImpfileTools } from './impfiles.js';
import { registerInvoiceTools } from './invoices.js';
import { registerMetaTools } from './meta.js';
import { registerOrderTools } from './orders.js';
import { registerProductTools } from './products.js';
import { registerPurchaseOrderTools } from './purchase-orders.js';
import { registerSalesReportTools } from './sales-report.js';
import { registerSupplierTools } from './suppliers.js';
import { registerWarehouseTools } from './warehouses.js';

export function registerAllTools(server: McpServer, client: PriorityClient, config: Config) {
  const gated = toolRegistry(server, config);

  registerCapabilityTools(gated, client, config);

  // Generic, form-agnostic building blocks (discovery + read + guarded write).
  registerGenericTools(gated, client, config);

  // Curated, domain-specific convenience tools.
  registerCustomerTools(gated, client, config);
  registerDebtTools(gated, client, config);
  registerInvoiceTools(gated, client, config);
  registerOrderTools(gated, client, config);
  registerProductTools(gated, client, config);
  registerSalesReportTools(gated, client);
  registerWarehouseTools(gated, client);
  registerSupplierTools(gated, client);
  registerPurchaseOrderTools(gated, client, config);
  registerFinanceTools(gated, client);
  registerActivityTools(gated, client, config);
  registerDocumentTools(gated, client, config);
  registerMetaTools(gated, client, config);

  // Import files (תיקי יבוא) — read + write + match/close tools, and the bonded-warehouse module.
  registerImpfileTools(gated, client, config);
  registerBondedTools(gated, client, config);
}
