// Finalization is procedure-dependent. This helper intentionally offers a plan only.
// A status description PATCH is not proof that a document was finalized.
import { pathToFileURL } from 'node:url';

export async function runFinalize(args, config, _client) {
  const confirm = args.includes('--confirm');
  const [form, ...ids] = args.filter((arg) => arg !== '--confirm');
  if (!form || !ids.length)
    throw new Error('Usage: finalize-docs.mjs FORM DOCUMENT_ID [DOCUMENT_ID ...] [--confirm]');
  return {
    status: confirm ? 'blocked' : 'preview',
    available: false,
    acknowledged: false,
    verified: false,
    form,
    documents: ids,
    verification: {
      reason:
        confirm && config.priorityReadOnly
          ? 'PRIORITY_READ_ONLY=true; finalization is also unavailable without a verified procedure.'
          : 'No verified finalization procedure is mapped. Writing STATDES cannot establish FINAL=Y, accounting posting, or financial completion.',
    },
    nextStep:
      'Use the supported Priority document procedure, then verify FINAL and the accounting/document identifiers with an uncached read. Enable an automated mapping only after an authorized test-company round trip.',
  };
}
async function main() {
  const { loadConfig } = await import('../dist/config.js');
  console.log(JSON.stringify(await runFinalize(process.argv.slice(2), loadConfig()), null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  });
}
