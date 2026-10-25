# Run and upgrade Priority MCP

Requires **Node 22.13+**. Version 0.2.0 preserves stdio and session-based Streamable HTTP; use the protocol negotiated by the installed SDK. No live service restart or deployment is performed by the local update.

## Local stdio

```sh
npm ci --ignore-scripts
npm run build
npm test
npm run test:mcp
node --env-file=.env dist/index.js
```

The environment file must supply either `PRIORITY_SERVICE_ROOT`, or `PRIORITY_BASE_URL` (through the `.ini` segment) plus company, or `PRIORITY_API_URL` (through `/odata/Priority`) plus environment and company. Precedence is in that order. Authentication prefers `PRIORITY_PAT`; the documented classic and legacy PAT forms also work. Read-only is on by default.

## Docker HTTP

Prepare a private `.env` with the connection/authentication and a strong `MCP_HTTP_AUTH_TOKEN`; keep `PRIORITY_READ_ONLY=true` for verification.

```sh
docker build -t priority-mcp-server:0.2.0 .
docker run --rm -p 127.0.0.1:3000:3000 --env-file .env \
  -e MCP_TRANSPORT=http -e MCP_HTTP_HOST=0.0.0.0 \
  priority-mcp-server:0.2.0
```

Container binding must be `0.0.0.0` for port forwarding; host publishing above stays loopback. Non-loopback binding without the token fails closed. For remote clients use a private/authenticated TLS ingress and explicitly allowed browser origins. Do not assume a platform's port variable is read: set `MCP_HTTP_PORT` yourself. Session idle lifetime is 30 minutes and concurrent session count is capped at 100.

`GET /health` checks process liveness only. Call `priority_healthcheck({checkBackend:true})` for an explicit read-only backend probe. `priority_get_capabilities({refresh:true,domain:"invoices"})` checks the forms on that page; it does not prove write permissions or procedure execution.

## Upgrade and rollback

1. Keep the previous built artifact, package lock and private configuration available locally.
2. Run clean install, unit tests, build, lint, stdio/HTTP protocol checks and dependency audit.
3. Restart only the intended MCP host once deployment is authorized. Confirm the advertised version, policy and tool count, then perform read-only smoke checks.
4. Validate new mutations only in an authorized test company/document and record readback separately.
5. For a software rollback restore the previous artifact/lock/config and restart that host. This does not reverse ERP transactions.

Cloud Run/Railway or other deployments require explicit host, port, token and TLS/ingress configuration. No public deployment is implied by these examples.
