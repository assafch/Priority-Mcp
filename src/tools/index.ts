import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PriorityClient } from '../client/priority-client.js';
import type { Config } from '../config.js';
import { registerCustomerTools } from './customers.js';
import { registerDebtTools } from './debts.js';
import { registerInvoiceTools } from './invoices.js';
import { registerOrderTools } from './orders.js';
import { registerProductTools } from './products.js';
import { registerWarehouseTools } from './warehouses.js';
import { registerSupplierTools } from './suppliers.js';
import { registerPurchaseOrderTools } from './purchase-orders.js';
import { registerFinanceTools } from './finance.js';
import { registerActivityTools } from './activities.js';
import { registerDocumentTools } from './documents.js';
import { registerMetaTools } from './meta.js';

export function registerAllTools(server: McpServer, client: PriorityClient, config: Config) {
  registerCustomerTools(server, client, config);
  registerDebtTools(server, client, config);
  registerInvoiceTools(server, client, config);
  registerOrderTools(server, client, config);
  registerProductTools(server, client, config);
  registerWarehouseTools(server, client);
  registerSupplierTools(server, client);
  registerPurchaseOrderTools(server, client, config);
  registerFinanceTools(server, client);
  registerActivityTools(server, client, config);
  registerDocumentTools(server, client, config);
  registerMetaTools(server, client, config);
}
