# Deployment Guide

## Local (stdio)

The default transport. Used by Claude Desktop, Claude Code, Cursor, and Windsurf.

```bash
npx priority-mcp-server
```

Or install globally:

```bash
npm install -g priority-mcp-server
priority-mcp-server
```

Required env vars must be set before running. See the [config reference](../README.md#configuration).

## Docker

```bash
# Build
docker build -t priority-mcp-server .

# Run (HTTP mode)
docker run -p 3000:3000 \
  -e PRIORITY_API_URL=https://your-server.com/odata/Priority/tabula.ini \
  -e PRIORITY_ENVIRONMENT=wlnd \
  -e PRIORITY_COMPANY=demodata \
  -e PRIORITY_USERNAME=apiuser \
  -e PRIORITY_PASSWORD=secret \
  -e MCP_TRANSPORT=http \
  priority-mcp-server
```

Or use an env file:

```bash
docker run -p 3000:3000 --env-file .env priority-mcp-server
```

The Docker image uses Google's distroless Node.js base for a minimal attack surface.

## Google Cloud Run

```bash
# Build and push to Artifact Registry
gcloud builds submit --tag gcr.io/YOUR_PROJECT/priority-mcp-server

# Deploy
gcloud run deploy priority-mcp-server \
  --image gcr.io/YOUR_PROJECT/priority-mcp-server \
  --platform managed \
  --region us-central1 \
  --port 3000 \
  --set-env-vars="MCP_TRANSPORT=http" \
  --set-env-vars="PRIORITY_API_URL=https://your-server.com/odata/Priority/tabula.ini" \
  --set-env-vars="PRIORITY_ENVIRONMENT=wlnd" \
  --set-env-vars="PRIORITY_COMPANY=demodata" \
  --update-secrets="PRIORITY_USERNAME=priority-username:latest,PRIORITY_PASSWORD=priority-password:latest" \
  --no-allow-unauthenticated
```

Use `--no-allow-unauthenticated` and Cloud IAM to control access. Store credentials in Secret Manager.

## Railway

1. Connect your GitHub repository in the [Railway dashboard](https://railway.app).
2. Set environment variables in the Railway service settings:
   - All `PRIORITY_*` vars
   - `MCP_TRANSPORT=http`
   - `MCP_HTTP_PORT=3000` (Railway sets `PORT` automatically, but this server uses `MCP_HTTP_PORT`)
3. Railway will auto-detect the Dockerfile and deploy.

Alternatively, deploy directly:

```bash
railway init
railway up
```

## Environment File Template

Create a `.env` file (never commit this):

```env
PRIORITY_API_URL=https://your-priority-server.com/odata/Priority/tabula.ini
PRIORITY_ENVIRONMENT=wlnd
PRIORITY_COMPANY=demodata
PRIORITY_USERNAME=apiuser
PRIORITY_PASSWORD=your-password
PRIORITY_LANGUAGE=EN
PRIORITY_READ_ONLY=true
CACHE_TTL_SECONDS=60
RATE_LIMIT_PER_MINUTE=120
LOG_LEVEL=info
MCP_TRANSPORT=stdio
```
