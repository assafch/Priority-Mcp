# --- Build stage ---
FROM node:22-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build && \
    npm prune --production

# --- Runtime stage ---
FROM gcr.io/distroless/nodejs22-debian12

WORKDIR /app

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

ENV NODE_ENV=production
ENV MCP_TRANSPORT=http
ENV MCP_HTTP_PORT=3000

EXPOSE 3000

CMD ["dist/index.js"]
