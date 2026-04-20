<p align="center">
  <img src="https://img.shields.io/badge/MCP-Server-5A45FF?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIyNCIgaGVpZ2h0PSIyNCIgdmlld0JveD0iMCAwIDI0IDI0IiBmaWxsPSJub25lIiBzdHJva2U9IndoaXRlIiBzdHJva2Utd2lkdGg9IjIiPjxwYXRoIGQ9Ik0xMiAyTDIgN2wxMCA1IDEwLTV6Ii8+PHBhdGggZD0iTTIgMTdsMTAgNSAxMC01Ii8+PHBhdGggZD0iTTIgMTJsMTAgNSAxMC01Ii8+PC9zdmc+" alt="MCP Server" />
  <img src="https://img.shields.io/badge/Priority-ERP-FF6B35?style=for-the-badge" alt="Priority ERP" />
  <img src="https://img.shields.io/badge/TypeScript-Strict-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
</p>

<h1 align="center">Priority MCP Server</h1>

<p align="center">
  <strong>Connect AI assistants to Priority ERP</strong><br/>
  72 tools &middot; 3 resources &middot; 5 workflow prompts &middot; 12 business domains
</p>

<p align="center">
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/license-MIT-green.svg" alt="MIT License" /></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D22-brightgreen.svg" alt="Node 22+" /></a>
  <a href="#tools-72"><img src="https://img.shields.io/badge/tools-72-blue.svg" alt="72 tools" /></a>
  <a href="#mcp-prompts-5"><img src="https://img.shields.io/badge/prompts-5-purple.svg" alt="5 prompts" /></a>
</p>

<p align="center">
  <a href="#-quick-start">Quick Start</a> &bull;
  <a href="#-setup-recipes">Setup Recipes</a> &bull;
  <a href="#%EF%B8%8F-configuration">Configuration</a> &bull;
  <a href="#-tools-72">Tools</a> &bull;
  <a href="#-deployment">Deployment</a> &bull;
  <a href="#-priority-setup">Priority Setup</a>
</p>

---

## What is this?

An open-source **[MCP (Model Context Protocol)](https://modelcontextprotocol.io)** server that wraps **Priority ERP's OData REST API** and exposes it as tools that any MCP-compatible AI assistant can use.

Ask your AI assistant things like:

> *"Show me all customers with overdue invoices over $10,000"*
>
> *"Create a sales order for customer C1001 with 50 units of product X"*
>
> *"Give me a morning briefing: new orders, cash position, and low stock alerts"*
>
> *"Run a debt collection workflow for customer ACME"*

Works with **Claude Desktop**, **Claude Code**, **Cursor**, **Windsurf**, and any MCP-compatible client.

---

## Quick Start

```bash
# Set your Priority credentials
export PRIORITY_API_URL="https://your-server.com/odata/Priority"
export PRIORITY_ENVIRONMENT="wlnd"
export PRIORITY_COMPANY="demodata"
export PRIORITY_USERNAME="apiuser"
export PRIORITY_PASSWORD="your-password"

# Run it
npx priority-mcp-server
```

The server starts on stdio and is ready for your MCP client. That's it.

---

## Setup Recipes

### Claude Desktop

Add to your config file:
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "priority": {
      "command": "npx",
      "args": ["-y", "priority-mcp-server"],
      "env": {
        "PRIORITY_API_URL": "https://your-server.com/odata/Priority",
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
claude mcp add priority \
  -e PRIORITY_API_URL="https://your-server.com/odata/Priority" \
  -e PRIORITY_ENVIRONMENT="wlnd" \
  -e PRIORITY_COMPANY="demodata" \
  -e PRIORITY_USERNAME="apiuser" \
  -e PRIORITY_PASSWORD="your-password" \
  -- npx -y priority-mcp-server
```

### Cursor

Open **Settings > MCP Servers > Add**, and paste the same JSON config as Claude Desktop above.

### Windsurf

Add to your Windsurf MCP configuration with the same JSON structure as Claude Desktop.

### Docker (Remote / HTTP mode)

```bash
docker run -p 3000:3000 \
  -e MCP_TRANSPORT=http \
  -e PRIORITY_API_URL="https://your-server.com/odata/Priority" \
  -e PRIORITY_ENVIRONMENT="wlnd" \
  -e PRIORITY_COMPANY="demodata" \
  -e PRIORITY_USERNAME="apiuser" \
  -e PRIORITY_PASSWORD="your-password" \
  ghcr.io/assafch/priority-mcp:latest
```

---

## Configuration

All configuration is via environment variables. Validated on startup — the server fails fast with a clear error if anything is missing.

| Variable | Required | Default | Description |
|:---------|:--------:|:-------:|:------------|
| `PRIORITY_API_URL` | **Yes** | — | Priority OData endpoint URL |
| `PRIORITY_ENVIRONMENT` | **Yes** | — | Environment name (e.g. `wlnd`, `demo`) |
| `PRIORITY_COMPANY` | **Yes** | — | Company database (e.g. `demodata`, `usdemo`) |
| `PRIORITY_USERNAME` | **Yes** | — | API username |
| `PRIORITY_PASSWORD` | **Yes** | — | API password |
| `PRIORITY_LANGUAGE` | No | `EN` | `EN` or `HE` — controls field name locale |
| `PRIORITY_CUSTOM_PREFIX` | No | — | Prefix for custom entities (e.g. `ORGT_`) |
| `PRIORITY_CUSTOM_ENTITIES` | No | — | Comma-separated custom entity names |
| `PRIORITY_READ_ONLY` | No | `false` | Block all write operations |
| `PRIORITY_ALLOWED_TOOLS` | No | — | Comma-separated tool allowlist |
| `PRIORITY_BLOCKED_TOOLS` | No | — | Comma-separated tool blocklist |
| `CACHE_TTL_SECONDS` | No | `60` | In-memory cache TTL |
| `RATE_LIMIT_PER_MINUTE` | No | `120` | Max API requests per minute |
| `LOG_LEVEL` | No | `info` | `trace` / `debug` / `info` / `warn` / `error` |
| `MCP_TRANSPORT` | No | `stdio` | `stdio` (local) or `http` (remote) |
| `MCP_HTTP_PORT` | No | `3000` | HTTP port when transport is `http` |

---

## Tools (72)

### Customers (10)

| Tool | Type | Description |
|:-----|:----:|:------------|
| `priority_list_customers` | Read | List customers with filters (status, balance, sales rep) |
| `priority_get_customer` | Read | Full customer record by CUSTNAME |
| `priority_search_customers` | Read | Fuzzy search by name, tax ID, phone, email |
| `priority_get_customer_balance` | Read | Open balance + credit limit + available credit |
| `priority_get_customer_contacts` | Read | Contact list with phone/email/role |
| `priority_get_customer_price_list` | Read | Assigned price list and discounts |
| `priority_get_customer_documents` | Read | All invoices, orders, quotes for a customer |
| `priority_get_customer_aging` | Read | Aging buckets (0-30, 31-60, 61-90, 90+ days) |
| `priority_create_customer` | Write | Create a new customer record |
| `priority_update_customer` | Write | Update customer fields |

### Debts & Collections (7)

| Tool | Type | Description |
|:-----|:----:|:------------|
| `priority_get_open_debts` | Read | All open AR, filterable by aging/amount/rep |
| `priority_get_aging_report` | Read | Company-wide aging with customer breakdown |
| `priority_get_overdue_invoices` | Read | Past-due invoices sorted by days overdue |
| `priority_get_payment_history` | Read | Historical payment behavior per customer |
| `priority_get_top_debtors` | Read | Top N customers by open debt |
| `priority_record_payment_promise` | Write | Log a promise-to-pay date |
| `priority_mark_invoice_disputed` | Write | Flag invoice as disputed with reason |

### Invoices (6)

| Tool | Type | Description |
|:-----|:----:|:------------|
| `priority_list_invoices` | Read | Filter by date range, customer, status |
| `priority_get_invoice` | Read | Full invoice with line items |
| `priority_get_unpaid_invoices_for_customer` | Read | Open invoices for collection workflow |
| `priority_create_invoice` | Write | Create invoice with line items |
| `priority_void_invoice` | Write | Void/cancel an invoice |
| `priority_create_credit_memo` | Write | Issue credit memo against invoice |

### Orders (9)

| Tool | Type | Description |
|:-----|:----:|:------------|
| `priority_list_orders` | Read | Sales orders with filters |
| `priority_get_order` | Read | Full order with lines and status |
| `priority_get_pending_orders` | Read | Orders awaiting fulfillment |
| `priority_get_order_shipment_status` | Read | Tracking info and carrier details |
| `priority_get_backorder_report` | Read | Orders with items out of stock |
| `priority_create_order` | Write | Create a new sales order |
| `priority_update_order` | Write | Modify order header/lines |
| `priority_cancel_order` | Write | Cancel with reason |
| `priority_confirm_order` | Write | Move to confirmed status |

### Products & Inventory (11)

| Tool | Type | Description |
|:-----|:----:|:------------|
| `priority_list_products` | Read | Products with category/stock/active filters |
| `priority_get_product` | Read | Full product details |
| `priority_search_products` | Read | Search by name, SKU, barcode |
| `priority_get_stock_levels` | Read | Per-warehouse stock with reserved/available |
| `priority_get_low_stock_alerts` | Read | Products below reorder point |
| `priority_get_out_of_stock` | Read | Zero-stock products |
| `priority_get_product_price` | Read | Price, optionally per customer |
| `priority_get_product_sales_history` | Read | Sales velocity data |
| `priority_update_product_price` | Write | Change list price |
| `priority_adjust_stock` | Write | Stock adjustment with reason code |
| `priority_transfer_stock` | Write | Move stock between warehouses |

### Warehouses (1)

| Tool | Type | Description |
|:-----|:----:|:------------|
| `priority_list_warehouses` | Read | All warehouses with location info |

### Suppliers (3)

| Tool | Type | Description |
|:-----|:----:|:------------|
| `priority_list_suppliers` | Read | List with search |
| `priority_get_supplier` | Read | Full supplier record |
| `priority_get_supplier_balance` | Read | Open AP balance |

### Purchase Orders (4)

| Tool | Type | Description |
|:-----|:----:|:------------|
| `priority_list_purchase_orders` | Read | POs with status/date filters |
| `priority_get_purchase_order` | Read | PO with line items |
| `priority_get_incoming_shipments` | Read | POs in transit with expected dates |
| `priority_create_purchase_order` | Write | Create a new PO |

### Finance & Analytics (8)

| Tool | Type | Description |
|:-----|:----:|:------------|
| `priority_get_bank_balances` | Read | All bank account balances |
| `priority_get_cash_position` | Read | Total cash across accounts |
| `priority_get_revenue_by_period` | Read | Revenue breakdown by date range |
| `priority_get_top_customers` | Read | Top customers by revenue |
| `priority_get_top_products` | Read | Top products by revenue |
| `priority_get_ar_aging_summary` | Read | AR aging summary |
| `priority_get_ap_aging_summary` | Read | AP aging summary |
| `priority_get_cashflow_projection` | Read | AR vs AP projection |

### Activities / CRM (5)

| Tool | Type | Description |
|:-----|:----:|:------------|
| `priority_list_activities` | Read | Calls, meetings, tasks |
| `priority_get_customer_activities` | Read | Activity history per customer |
| `priority_get_open_tasks` | Read | Pending tasks by due date |
| `priority_create_activity` | Write | Log a call/email/meeting |
| `priority_schedule_followup` | Write | Create a future-dated task |

### Documents (3)

| Tool | Type | Description |
|:-----|:----:|:------------|
| `priority_list_attachments` | Read | Attachments for any entity |
| `priority_get_attachment_url` | Read | Download URL for a file |
| `priority_upload_attachment` | Write | Attach file to an entity |

### Meta / Admin (5)

| Tool | Type | Description |
|:-----|:----:|:------------|
| `priority_list_entities` | Read | Discover all available entities |
| `priority_get_entity_schema` | Read | Field list and types for any entity |
| `priority_list_companies` | Read | Companies in the environment |
| `priority_get_current_user` | Read | Current auth context |
| `priority_execute_odata_query` | Read | Raw OData escape hatch |

---

## MCP Resources (3)

| URI | Description |
|:----|:------------|
| `priority://schema/{entity}` | JSON schema of any entity |
| `priority://company/info` | Current company metadata |
| `priority://user/profile` | Current user and connection info |

---

## MCP Prompts (5)

| Prompt | Description |
|:-------|:------------|
| `debt_collection_workflow` | Step-by-step collection workflow for a customer |
| `daily_briefing` | Morning briefing: orders, overdue, cash, stock, tasks |
| `cash_position_summary` | Cash snapshot with AR/AP projection |
| `order_fulfillment_check` | Can this order ship? Stock check + ETA |
| `inventory_reorder_check` | Products needing reorder with suggested quantities |

---

## Write Tool Safety

All 18 write tools include built-in safety:

- **Dry-run by default** — every write tool defaults to `dryRun: true`, previewing the payload without making changes
- **Read-only mode** — set `PRIORITY_READ_ONLY=true` to disable all writes globally
- **Tool allowlist/blocklist** — fine-grained control over which tools are exposed

---

## Deployment

### Local (stdio)

```bash
npx priority-mcp-server
```

### Docker

```bash
docker build -t priority-mcp-server .
docker run -p 3000:3000 --env-file .env -e MCP_TRANSPORT=http priority-mcp-server
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

See [docs/deployment.md](docs/deployment.md) for detailed guides.

---

## Priority Setup

1. **Create an API user** in Priority under **System Management > Users**
2. **Assign permissions** — the user needs access to the entities you want to expose
3. **Enable OData** — ensure the Priority OData REST API is accessible over HTTPS
4. **Test the connection:**
   ```bash
   curl -u user:pass "https://your-server/odata/Priority/wlnd/odata/Priority/tabula.ini/demodata/CUSTOMERS?\$top=1"
   ```
5. For read-only access, remove write permissions in Priority **and** set `PRIORITY_READ_ONLY=true`

See [docs/priority-notes.md](docs/priority-notes.md) for OData quirks, Hebrew field names, date formats, and other gotchas.

---

## Security

| Feature | Description |
|:--------|:------------|
| Read-only mode | `PRIORITY_READ_ONLY=true` blocks all writes |
| Tool access control | Allowlist or blocklist specific tools |
| Rate limiting | Built-in, configurable per-minute limit |
| Credential safety | Never logged, never in tool responses |
| PII redaction | Phone, email, tax ID redacted from logs |
| Distroless Docker | Minimal attack surface in production |

See [docs/security.md](docs/security.md) for the full security guide.

---

## Development

```bash
git clone https://github.com/assafch/Priority-Mcp.git
cd Priority-Mcp
npm install
npm run dev        # Run with Node's TypeScript stripping
npm test           # Vitest
npm run lint       # Biome
npm run inspect    # MCP Inspector
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines.

---

## Architecture

```
src/
├── index.ts              # Entrypoint — stdio or HTTP transport
├── server.ts             # McpServer setup
├── config.ts             # Zod env validation
├── logger.ts             # Pino structured logging
├── client/               # Priority OData HTTP client
│   ├── priority-client.ts
│   ├── odata-builder.ts  # Type-safe $filter/$expand/$select builder
│   ├── cache.ts          # In-memory LRU with TTL
│   ├── rate-limit.ts     # Sliding window rate limiter
│   └── errors.ts         # Priority→MCP error mapping
├── tools/                # 72 MCP tools across 12 files
├── resources/            # 3 MCP resources
├── prompts/              # 5 MCP prompts
└── lib/                  # Shared utilities
```

---

## License

[MIT](LICENSE) — use it however you want.

---

<p align="center">
  Built for the Priority ERP community<br/>
  <sub>Contributions welcome &middot; <a href="https://github.com/assafch/Priority-Mcp/issues">Report issues</a></sub>
</p>
