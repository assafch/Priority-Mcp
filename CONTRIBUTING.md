# Contributing to priority-mcp-server

Thank you for your interest in contributing!

## Development Setup

```bash
git clone https://github.com/anthropic-community/priority-mcp-server.git
cd priority-mcp-server
npm install
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Run in development mode (uses Node's experimental TS strip) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm test` | Run tests with Vitest |
| `npm run lint` | Lint with Biome |
| `npm run lint:fix` | Auto-fix lint issues |
| `npm run inspect` | Open MCP Inspector for interactive testing |

## Project Structure

```
src/
  index.ts          # Entry point — stdio/http transport setup
  server.ts         # MCP server creation and tool registration
  config.ts         # Environment variable schema (Zod)
  logger.ts         # Pino logger setup
  client/           # Priority OData HTTP client
  tools/            # MCP tool definitions (one file per domain)
  lib/              # Shared helpers (types, sanitization, write guard)
tests/              # Vitest test files
```

## Adding a New Tool

1. Pick the appropriate file in `src/tools/` (or create a new one for a new domain).
2. Add your `server.tool(...)` call following the existing pattern:
   - Provide a clear, multi-line description with example queries.
   - Use Zod schemas for all parameters.
   - Return results via `textResult()`.
3. If you created a new file, register it in `src/tools/index.ts`.
4. Add tests in `tests/`.
5. Run `npm test && npm run lint` before submitting.

## Pull Request Guidelines

- Keep PRs focused on a single change.
- Include tests for new tools or bug fixes.
- Update the tool count in docs if you add/remove tools.
- All CI checks must pass.

## Code Style

This project uses [Biome](https://biomejs.dev/) for formatting and linting. Run `npm run lint:fix` before committing.

## Reporting Issues

Please open a GitHub issue with:
- Steps to reproduce
- Expected vs actual behavior
- Your Priority ERP version (if relevant)
