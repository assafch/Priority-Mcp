/**
 * Daily Briefing Agent
 *
 * Uses the Vercel AI SDK with Claude to generate a morning business briefing
 * by calling Priority MCP tools for AR, orders, inventory, and activities.
 *
 * Usage:
 *   npx tsx examples/agents/daily-briefing.ts
 *
 * Requirements:
 *   npm install ai @ai-sdk/anthropic
 *
 * Environment:
 *   ANTHROPIC_API_KEY  — your Anthropic API key
 *   Plus all PRIORITY_* env vars (the MCP server runs as a subprocess)
 */

import { generateText } from 'ai';
import { anthropic } from '@ai-sdk/anthropic';

const today = new Date().toISOString().slice(0, 10);

const { text } = await generateText({
  model: anthropic('claude-sonnet-4-20250514'),
  tools: {}, // In a real setup, wire MCP tools here via @anthropic-ai/mcp-client
  maxSteps: 10,
  system: `You are a CFO assistant connected to Priority ERP via MCP tools.
Today is ${today}. Generate a concise daily business briefing.`,
  prompt: `Generate my morning briefing. Include:

1. **Cash Position** — current bank balances and net cash
2. **Accounts Receivable** — total open AR, overdue amount, top 3 overdue invoices
3. **Today's Orders** — new orders from yesterday, pending fulfillment count
4. **Inventory Alerts** — any low-stock or out-of-stock items
5. **Open Tasks** — CRM tasks due today or overdue
6. **Cashflow Outlook** — 30-day projection summary

Use the Priority MCP tools to fetch real data. Format as a clean markdown briefing.`,
});

console.log(text);
