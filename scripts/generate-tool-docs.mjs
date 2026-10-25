import { writeFile } from 'node:fs/promises';
import { TOOL_DEFINITIONS } from '../dist/lib/capability-definitions.js';
const rows = [...TOOL_DEFINITIONS].sort(
  (a, b) => a.domain.localeCompare(b.domain) || a.name.localeCompare(b.name),
);
const lines = [
  '# Tool capabilities — 0.2.0',
  '',
  'This catalog describes code, not current tenant permissions. Use `priority_get_capabilities` for policy and dated form-readability evidence; follow `nextSkip`. A successful form probe does not enable an unavailable handler or prove a write.',
  '',
  `${rows.length} registered definitions. Existing tool names remain available subject to allow/block policy. Every tool has risk annotations and an object output schema; JSON text and structured content agree.`,
  '',
  '| Tool | Domain | Mode | Implementation |',
  '| --- | --- | --- | --- |',
  ...rows.map((t) => `| \`${t.name}\` | ${t.domain} | ${t.mode} | ${t.implementation} |`),
  '',
  '## Key and result contracts',
  '',
  'Generic get/update/add-line and attachment tools support validated simple or composite keys. Supply exactly one of `key` or `keys` (attachment tools retain `entityKey` for legacy simple keys). `priority_update_line` updates a validated subform row. Write tools default to preview and preserve read-only policy.',
  '',
  'Write status separates preview, blocked, verified, unverified, unknown and failed. An acknowledgment is not business completion. Partial scans expose completeness and continuation; bounded results remain valid JSON with omission metadata. Five guide tools do not execute Priority procedures. Twenty-four legacy tools still require validated tenant mappings or procedures.',
  '',
  '## Discovery examples',
  '',
  '```json',
  '{"domain":"invoices","includeUnavailable":true,"refresh":false,"top":25,"skip":0}',
  '```',
  '',
  'Call `priority_healthcheck` without arguments for local diagnostics, or set `checkBackend:true` for a read-only backend check. No diagnostic tool mutates ERP data.',
  '',
];
await writeFile(new URL('../docs/tools.md', import.meta.url), lines.join('\n'));
console.log(`Documented ${rows.length} tool definitions.`);
