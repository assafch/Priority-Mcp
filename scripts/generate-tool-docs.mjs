import { writeFile } from 'node:fs/promises';
import { TOOL_DEFINITIONS } from '../dist/lib/capability-definitions.js';
const rows = [...TOOL_DEFINITIONS].sort(
  (a, b) => a.domain.localeCompare(b.domain) || a.name.localeCompare(b.name),
);
const lines = [
  '# Tool capabilities — unreleased faster/smarter update',
  '',
  'This catalog describes code, not current tenant permissions. Use `priority_get_capabilities` for policy and dated form-readability evidence; follow `nextSkip`. A successful form probe does not enable an unavailable handler or prove a write.',
  '',
  `${rows.length} registered definitions. All 105 legacy names remain in the default full profile, subject to allow/block policy. The opt-in operations profile is capped at 25 implemented tools; hidden dependencies still require explicit policy permission. Every tool has risk annotations and an object output schema; JSON text and structured content agree.`,
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
  'Detailed tool help: `priority://tools/{name}` or `priority_get_capabilities` with `names` and `view:detail`. Typed resolver/query/workflow outputs carry evidence and completeness. See [performance rollout](performance-rollout.md).',
  '',
  'Call `priority_healthcheck` without arguments for local diagnostics, or set `checkBackend:true` for a read-only backend check. No diagnostic tool mutates ERP data.',
  '',
];
await writeFile(new URL('../docs/tools.md', import.meta.url), lines.join('\n'));
console.log(`Documented ${rows.length} tool definitions.`);
