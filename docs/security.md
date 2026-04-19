# Security Guide

## Authentication

This server authenticates to Priority's OData API using HTTP Basic Auth (username + password). Credentials are passed via environment variables and never logged or exposed in tool responses.

## Read-Only Mode

Set `PRIORITY_READ_ONLY=true` to prevent all write operations. In this mode, any tool that creates, updates, or deletes data will return a dry-run preview instead of executing the change. This is recommended for:

- Demo / evaluation environments
- Read-only analyst users
- Any deployment where accidental writes are a concern

## Tool Access Control

Restrict which tools are available using allow/block lists:

```bash
# Only expose these tools
PRIORITY_ALLOWED_TOOLS=priority_list_customers,priority_get_customer,priority_list_orders

# Or block specific tools (cannot be combined with ALLOWED)
PRIORITY_BLOCKED_TOOLS=priority_create_invoice,priority_void_invoice,priority_execute_odata_query
```

Block `priority_execute_odata_query` if you want to prevent arbitrary OData queries.

## Network Security

### Priority API Access

- Use HTTPS for the Priority API URL. Never use plain HTTP in production.
- If Priority is behind a VPN/firewall, ensure the MCP server can reach it.
- Consider using a dedicated API user with minimal permissions in Priority.

### MCP Server Access (HTTP mode)

When running in HTTP transport mode:

- Do **not** expose the server to the public internet without authentication.
- Use a reverse proxy (nginx, Cloudflare Tunnel) with TLS and auth.
- On Cloud Run, use `--no-allow-unauthenticated` and Cloud IAM.
- The server binds to `0.0.0.0` inside Docker; use network policies to restrict access.

### Stdio Mode

In stdio mode (the default), the server communicates only via stdin/stdout with the parent process (Claude Desktop, etc.). There is no network listener, so no network attack surface.

## Credential Management

- **Never** commit `.env` files or credentials to version control.
- Use platform-specific secret management:
  - **Cloud Run**: Google Secret Manager
  - **Railway**: Railway service variables (encrypted at rest)
  - **Docker**: Docker secrets or `--env-file` with restricted file permissions
  - **Local**: Environment variables or a `.env` file with `chmod 600`

## Priority User Permissions

Create a dedicated API user in Priority with the minimum required permissions:

1. Go to **System Management > Users** in Priority.
2. Create a user (e.g., `APIUSER`).
3. Assign only the company/companies needed.
4. Set form-level permissions to restrict which screens the user can access.
5. For read-only use, remove all write/update/delete permissions at the Priority level as well.

## Rate Limiting

The server includes built-in rate limiting (`RATE_LIMIT_PER_MINUTE`, default 120). This protects against runaway AI loops making excessive API calls to your Priority server.

## Logging

Set `LOG_LEVEL=warn` or `LOG_LEVEL=error` in production to avoid logging sensitive data. The `debug` and `trace` levels may log request/response details.
