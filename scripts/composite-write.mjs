// Portable composite-key helper. Build first; writes preview unless --confirm is supplied.
// node --env-file=.env scripts/composite-write.mjs patch FORM '{"K":"v"}' '{"F":"new"}' [--confirm]
// addline FORM KEYS SUBFORM BODY | patchline FORM KEYS SUBFORM LINE_KEYS BODY | get FORM KEYS [QUERY]
import { pathToFileURL } from 'node:url';

export async function runComposite(args, config, client) {
  const confirm = args.includes('--confirm');
  const [command, form, keysJson, a, b, c] = args.filter((arg) => arg !== '--confirm');
  if (!['get', 'patch', 'addline', 'patchline'].includes(command) || !form || !keysJson)
    throw new Error(
      'Usage: get|patch|addline|patchline FORM KEYS_JSON [SUBFORM] [LINE_KEYS_JSON] [BODY_JSON] [--confirm]. Deletes are unsupported.',
    );
  const keys = JSON.parse(keysJson);
  const endpoint =
    command === 'addline'
      ? client.resolveSubformUrl(form, keys, a)
      : command === 'patchline'
        ? client.resolveSubformRowUrl(form, keys, a, JSON.parse(b))
        : client.resolveCompositeUrl(form, keys, command === 'get' ? a : undefined);
  if (command === 'get') return client.getComposite(form, keys, a, { cache: false });
  const body = JSON.parse(command === 'patch' ? a : command === 'addline' ? b : c);
  if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.keys(body).length)
    throw new Error('BODY_JSON must be a non-empty object.');
  const method = command === 'addline' ? 'POST' : 'PATCH';
  if (!confirm)
    return {
      status: 'preview',
      acknowledged: false,
      verified: false,
      verification: {
        reason:
          'No request sent. Key schema validation occurs before an explicitly confirmed write.',
      },
      wouldSend: { method, endpoint, body },
    };
  if (config.priorityReadOnly)
    return {
      status: 'blocked',
      acknowledged: false,
      verified: false,
      verification: { reason: 'PRIORITY_READ_ONLY=true. The helper never overrides it.' },
    };
  const [{ resolveRecordKey }, { verifyRecordUpdate, verifyLineCreate, verifyWrite }] =
    await Promise.all([
      import('../dist/lib/record-key.js'),
      import('../dist/lib/write-verification.js'),
    ]);
  await resolveRecordKey(client, form, undefined, keys);
  if (command === 'patch') return verifyRecordUpdate(client, form, keys, body);
  if (command === 'addline') return verifyLineCreate(client, form, keys, a, body);
  const lineKeys = JSON.parse(b);
  await resolveRecordKey(client, a, undefined, lineKeys);
  return verifyWrite(
    () => client.updateSubformRow(form, keys, a, lineKeys, body),
    () => client.getSubformRow(form, keys, a, lineKeys, undefined, { cache: false }),
    body,
  );
}

async function main() {
  const [{ loadConfig }, { createLogger }, { PriorityClient }] = await Promise.all([
    import('../dist/config.js'),
    import('../dist/logger.js'),
    import('../dist/client/priority-client.js'),
  ]);
  const config = loadConfig();
  const client = new PriorityClient(config, createLogger({ ...config, logLevel: 'error' }));
  console.log(JSON.stringify(await runComposite(process.argv.slice(2), config, client), null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(JSON.stringify({ error: error.message }));
    process.exitCode = 1;
  });
}
