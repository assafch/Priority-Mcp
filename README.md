# priority-mcp-server

MCP server that connects AI assistants to Priority ERP via its OData API. 72 tools across 12 business domains.

[![npm](https://img.shields.io/npm/v/priority-mcp-server)](https://www.npmjs.com/package/priority-mcp-server)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](https://nodejs.org)

## Quick Start (60 seconds)

```bash
# Set your Priority credentials
export PRIORITY_API_URL="https://your-server.com/odata/Priority/tabula.ini"
export PRIORITY_ENVIRONMENT="wlnd"
export PRIORITY_COMPANY="demodata"
export PRIORITY_USERNAME="apiuser"
export PRIORITY_PASSWORD="your-password"

# Run it
npx priority-mcp-server
```

That's it. The server starts on stdio and is ready for Claude Desktop, Claude Code, Cursor, or any MCP client.

## Setup Recipes

### Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "priority": {
      "command": "npx",
      "args": ["-y", "priority-mcp-server"],
      "env": {
        "PRIORITY_API_URL": "https://your-server.com/odata/Priority/tabula.ini",
        "PRIORITY_ENVIRONMENT": "wlnd",
        "PRIORITY_COMPANY": "demodata",
        "PRIORITY_USERNAME": "apiuser",
        "PRIORITY_PASSWORD": "your-password"
      }
    }
  }
}
```

### Claude Code

```bash
claude mcp add priority -- npx -y priority-mcp-server
```

Set env vars in your shell profile or `.env` file before launching Claude Code.

### Cursor

Open **Settings > MCP Servers**, click **Add**, and paste:

```json
{
  "mcpServers": {
    "priority": {
      "command": "npx",
      "args": ["-y", "priority-mcp-server"],
      "env": {
        "PRIORITY_API_URL": "https://your-server.com/odata/Priority/tabula.ini",
        "PRIORITY_ENVIRONMENT": "wlnd",
        "PRIORITY_COMPANY": "demodata",
        "PRIORITY_USERNAME": "apiuser",
        "PRIORITY_PASSWORD": "your-password"
      }
    }
  }
}
```

### Windsurf

Add to your Windsurf MCP config (similar to Cursor):

```json
{
  "mcpServers": {
    "priority": {
      "command": "npx",
      "args": ["-y", "priority-mcp-server"],
      "env": {
        "PRIORITY_API_URL": "https://your-server.com/odata/Priority/tabula.ini",
        "PRIORITY_ENVIRONMENT": "wlnd",
        "PRIORITY_COMPANY": "demodata",
        "PRIORITY_USERNAME": "apiuser",
        "PRIORITY_PASSWORD": "your-password"
      }
    }
  }
}
```

## Configuration

All configuration is via environment variables.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PRIORITY_API_URL` | Yes | — | Priority OData endpoint URL |
| `PRIORITY_ENVIRONMENT` | Yes | — | Priority environment name (e.g. `wlnd`) |
| `PRIORITY_COMPANY` | Yes | — | Company name within the environment |
| `PRIORITY_USERNAME` | Yes | — | API username |
| `PRIORITY_PASSWORD` | Yes | — | API password |
| `PRIORITY_LANGUAGE` | No | `EN` | Language: `EN` or `HE` |
| `PRIORITY_CUSTOM_PREFIX` | No | — | Prefix for custom entities (e.g. `Z`) |
| `PRIORITY_CUSTOM_ENTITIES` | No | — | Comma-separated list of custom entity names |
| `PRIORITY_READ_ONLY` | No | `false` | Set to `true` to block all write operations |
| `PRIORITY_ALLOWED_TOOLS` | No | — | Comma-separated whitelist of tool names |
| `PRIORITY_BLOCKED_TOOLS` | No | — | Comma-separated blacklist of tool names |
| `CACHE_TTL_SECONDS` | No | `60` | Response cache TTL in seconds |
| `RATE_LIMIT_PER_MINUTE` | No | `120` | Max API calls per minute |
| `LOG_LEVEL` | No | `info` | Log level: `trace`, `debug`, `info`, `warn`, `error` |
| `MCP_TRANSPORT` | No | `stdio` | Transport: `stdio` or `http` |
| `MCP_HTTP_PORT` | No | `3000` | HTTP server port (when `MCP_TRANSPORT=http`) |

## Tools (72)

### Customers (10)

| Tool | Description |
|------|-------------|
| `priority_list_customers` | List customers with optional filters |
| `priority_get_customer` | Get a single customer by number |
| `priority_search_customers` | Fuzzy search by name, tax ID, phone, or email |
| `priority_get_customer_balance` | Get open AR balance |
| `priority_get_customer_contacts` | List contacts (names, phones, emails, roles) |
| `priority_get_customer_price_list` | Get assigned price list and discount rules |
| `priority_get_customer_documents` | List all documents (invoices, orders, quotes) |
| `priority_get_customer_aging` | Aging buckets (0-30, 31-60, 61-90, 90+ days) |
| `priority_create_customer` | Create a new customer |
| `priority_update_customer` | Update an existing customer |

### Orders (9)

| Tool | Description |
|------|-------------|
| `priority_list_orders` | List sales orders with filters |
| `priority_get_order` | Get order with line items |
| `priority_get_pending_orders` | Orders awaiting fulfillment |
| `priority_get_order_shipment_status` | Shipment/tracking info |
| `priority_get_backorder_report` | Orders with backordered items |
| `priority_create_order` | Create a new sales order |
| `priority_update_order` | Update header or line items |
| `priority_cancel_order` | Cancel with a reason |
| `priority_confirm_order` | Confirm/approve an order |

### Products (11)

| Tool | Description |
|------|-------------|
| `priority_list_products` | List products with filters |
| `priority_get_product` | Full product details |
| `priority_search_products` | Search by name, SKU, or barcode |
| `priority_get_stock_levels` | Stock across all warehouses |
| `priority_get_low_stock_alerts` | Products below reorder point |
| `priority_get_out_of_stock` | Products with zero stock |
| `priority_get_product_price` | Price, optionally per customer |
| `priority_get_product_sales_history` | Sales velocity data |
| `priority_update_product_price` | Update list price |
| `priority_adjust_stock` | Adjust stock with reason code |
| `priority_transfer_stock` | Transfer between warehouses |

### Invoices (6)

| Tool | Description |
|------|-------------|
| `priority_list_invoices` | List with date/customer/status filters |
| `priority_get_invoice` | Single invoice with line items |
| `priority_get_unpaid_invoices_for_customer` | Unpaid invoices for a customer |
| `priority_create_invoice` | Create a new invoice |
| `priority_void_invoice` | Void/cancel an invoice |
| `priority_create_credit_memo` | Credit memo against an invoice |

### Debts / AR (7)

| Tool | Description |
|------|-------------|
| `priority_get_open_debts` | All open AR debts |
| `priority_get_aging_report` | Company-wide aging with customer breakdown |
| `priority_get_overdue_invoices` | Past-due invoices by days overdue |
| `priority_get_payment_history` | Customer payment behavior |
| `priority_get_top_debtors` | Top N customers by debt |
| `priority_record_payment_promise` | Record promise-to-pay date |
| `priority_mark_invoice_disputed` | Flag invoice as disputed |

### Finance (8)

| Tool | Description |
|------|-------------|
| `priority_get_bank_balances` | All bank account balances |
| `priority_get_cash_position` | Net cash position |
| `priority_get_revenue_by_period` | Revenue breakdown by period |
| `priority_get_top_customers` | Top customers by revenue |
| `priority_get_top_products` | Top products by revenue |
| `priority_get_ar_aging_summary` | AR aging summary |
| `priority_get_ap_aging_summary` | AP aging summary |
| `priority_get_cashflow_projection` | Cashflow projection (AR vs AP) |

### Purchase Orders (4)

| Tool | Description |
|------|-------------|
| `priority_list_purchase_orders` | List POs with filters |
| `priority_get_purchase_order` | Single PO with line items |
| `priority_get_incoming_shipments` | POs in transit |
| `priority_create_purchase_order` | Create a new PO |

### Suppliers (3)

| Tool | Description |
|------|-------------|
| `priority_list_suppliers` | List suppliers with filters |
| `priority_get_supplier` | Full supplier record |
| `priority_get_supplier_balance` | Open AP balance |

### Warehouses (1)

| Tool | Description |
|------|-------------|
| `priority_list_warehouses` | List all warehouses |

### Activities / CRM (5)

| Tool | Description |
|------|-------------|
| `priority_list_activities` | List CRM activities |
| `priority_get_customer_activities` | Activity history for a customer |
| `priority_get_open_tasks` | Open/pending tasks |
| `priority_create_activity` | Log a new activity |
| `priority_schedule_followup` | Schedule a follow-up task |

### Documents (3)

| Tool | Description |
|------|-------------|
| `priority_list_attachments` | List attachments for any entity |
| `priority_get_attachment_url` | Get download URL |
| `priority_upload_attachment` | Upload/attach a file |

### Meta / Schema (5)

| Tool | Description |
|------|-------------|
| `priority_list_entities` | List all available entities |
| `priority_get_entity_schema` | Field list and types for an entity |
| `priority_list_companies` | List companies in the environment |
| `priority_get_current_user` | Current API user info |
| `priority_execute_odata_query` | Raw OData query against any entity |

## Deployment

### Local (stdio)

```bash
npx priority-mcp-server
```

### Docker

```bash
docker build -t priority-mcp-server .
docker run -p 3000:3000 --env-file .env priority-mcp-server
```

### Google Cloud Run

```bash
gcloud builds submit --tag gcr.io/YOUR_PROJECT/priority-mcp-server
gcloud run deploy priority-mcp-server \
  --image gcr.io/YOUR_PROJECT/priority-mcp-server \
  --port 3000 \
  --set-env-vars="MCP_TRANSPORT=http" \
  --update-secrets="PRIORITY_PASSWORD=priority-password:latest" \
  --no-allow-unauthenticated
```

### Railway

Connect your repo on [railway.app](https://railway.app), set env vars, and deploy. Railway auto-detects the Dockerfile.

See [docs/deployment.md](docs/deployment.md) for full deployment guides.

## Priority Setup

1. Create a dedicated API user in Priority under **System Management > Users**.
2. Assign the user to the target company with appropriate permissions.
3. For read-only access, remove write permissions at the Priority level and set `PRIORITY_READ_ONLY=true`.
4. Ensure the Priority OData API is accessible over HTTPS from where you run this server.
5. Test the connection: `curl -u user:pass "https://your-server/odata/Priority/tabula.ini/wlnd/demodata/CUSTOMERS?$top=1"`

See [docs/priority-notes.md](docs/priority-notes.md) for OData quirks and field naming conventions.

## Security

- **Read-only mode**: `PRIORITY_READ_ONLY=true` blocks all writes (returns dry-run previews instead).
- **Tool allow/block lists**: `PRIORITY_ALLOWED_TOOLS` or `PRIORITY_BLOCKED_TOOLS` to restrict tool access.
- **Rate limiting**: Built-in, configurable via `RATE_LIMIT_PER_MINUTE`.
- **No credential logging**: Credentials are never logged or included in tool responses.
- **Distroless Docker image**: Minimal attack surface in production.

See [docs/security.md](docs/security.md) for the full security guide.

## Development

```bash
git clone https://github.com/anthropic-community/priority-mcp-server.git
cd priority-mcp-server
npm install
npm run dev      # Run with Node's TS strip
npm test         # Run tests
npm run lint     # Lint with Biome
npm run inspect  # Open MCP Inspector
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full contributing guide.

## License

MIT
