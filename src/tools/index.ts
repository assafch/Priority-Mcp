import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { PriorityClient } from '../client/priority-client.js';
import type { Config } from '../config.js';
import { registerActivityTools } from './activities.js';
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

/**
 * Wrap the server so tool registration honors PRIORITY_ALLOWED_TOOLS / PRIORITY_BLOCKED_TOOLS.
 * A tool whose name is blocked (or not in a non-empty allowlist) is DISABLED, so it is filtered
 * out of tools/list and rejected by tools/call — invisible and uncallable, just like before.
 *
 * Why disable instead of skip registration: the MCP SDK lazily initializes the `tools` capability
 * and the tools/list & tools/call request handlers on the FIRST real server.tool() call. If a
 * config (e.g. a PRIORITY_ALLOWED_TOOLS with a typo that matches no tool) filtered out EVERY tool,
 * the old "skip registration" gate meant server.tool() was never called, so the server advertised
 * no tools capability and answered tools/list with a JSON-RPC "Method not found" error instead of
 * an empty list — the server looked broken rather than empty. Registering every tool and disabling
 * the disallowed ones guarantees the handlers are always initialized. Returns the server unchanged
 * when neither list is set.
 */
function gateToolRegistration(server: McpServer, config: Config): McpServer {
  const allow = config.priorityAllowedTools;
  const block = new Set(config.priorityBlockedTools ?? []);
  if (!allow && block.size === 0) return server;

  const isAllowed = (name: string) => !block.has(name) && (!allow || allow.includes(name));

  return new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === 'tool') {
        const original = target.tool.bind(target) as (
          ...args: unknown[]
        ) => { disable?: () => void } | undefined;
        return (name: string, ...rest: unknown[]) => {
          const registered = original(name, ...rest);
          if (!isAllowed(name)) registered?.disable?.();
          return registered;
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

export function registerAllTools(server: McpServer, client: PriorityClient, config: Config) {
  const gated = gateToolRegistration(server, config);

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
