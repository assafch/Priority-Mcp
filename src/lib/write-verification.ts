import { PriorityError } from '../client/errors.js';
import type { PriorityClient } from '../client/priority-client.js';
import { getSchema } from './priority-schema.js';
import type { NamedKeys, RecordKey } from './record-key.js';

export type WriteStatus = 'verified' | 'unverified' | 'unknown' | 'failed';
export interface WriteOutcome {
  status: WriteStatus;
  acknowledged: boolean;
  verified: boolean;
  result?: unknown;
  verification: { expected: unknown; observed?: unknown; reason?: string };
}
/** Match requested public fields recursively, without coercing false/null/empty values. */
export function matchesExpected(observed: unknown, expected: unknown): boolean {
  if (expected === null || typeof expected !== 'object') return Object.is(observed, expected);
  if (Array.isArray(expected))
    return (
      Array.isArray(observed) &&
      expected.length === observed.length &&
      expected.every((v, i) => matchesExpected(observed[i], v))
    );
  if (!observed || typeof observed !== 'object' || Array.isArray(observed)) return false;
  return Object.entries(expected).every(
    ([k, v]) =>
      Object.hasOwn(observed, k) && matchesExpected((observed as Record<string, unknown>)[k], v),
  );
}
function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
/** Never resubmit a write. A lost response is ambiguous; a failed readback retains acknowledgment. */
export async function verifyWrite(
  write: () => Promise<unknown>,
  read: (result: unknown) => Promise<unknown>,
  expected: unknown,
): Promise<WriteOutcome> {
  let result: unknown;
  try {
    result = await write();
  } catch (error) {
    const status = error instanceof PriorityError ? error.statusCode : undefined;
    const acknowledged = status !== undefined && status >= 200 && status < 300;
    const rejected = status !== undefined && status >= 400 && status < 500 && status !== 408;
    return {
      status: rejected ? 'failed' : 'unknown',
      acknowledged,
      verified: false,
      verification: { expected, reason: reason(error) },
    };
  }
  try {
    const observed = await read(result);
    const verified = matchesExpected(observed, expected);
    return {
      status: verified ? 'verified' : 'unverified',
      acknowledged: true,
      verified,
      result,
      verification: {
        expected,
        observed,
        ...(verified
          ? {}
          : {
              reason:
                'Readback did not match every requested field; the write may have been ignored or only partially applied.',
            }),
      },
    };
  } catch (error) {
    return {
      status: 'unverified',
      acknowledged: true,
      verified: false,
      result,
      verification: {
        expected,
        reason: `Write acknowledged; readback unavailable: ${reason(error)}`,
      },
    };
  }
}
export function verifyRecordUpdate(
  client: PriorityClient,
  form: string,
  key: RecordKey,
  body: Record<string, unknown>,
) {
  return verifyWrite(
    () => client.update(form, key, body),
    () => client.get(form, key, undefined, { cache: false }),
    body,
  );
}
export function verifyRecordCreate(
  client: PriorityClient,
  form: string,
  body: Record<string, unknown>,
) {
  return verifyWrite(
    () => client.create(form, body),
    async (result) => {
      const fields = getSchema(form)?.key;
      if (!fields?.length || !result || typeof result !== 'object')
        throw new Error(
          'No verified record identity was returned; preserve the response and inspect the document before retrying.',
        );
      const row = result as Record<string, unknown>;
      const keys: NamedKeys = {};
      for (const field of fields) {
        const value = row[field];
        if (typeof value !== 'string' && typeof value !== 'number')
          throw new Error(`Response lacks key ${field}.`);
        keys[field] = value;
      }
      const lineSubform = getSchema(form)?.lineSubform;
      const query =
        lineSubform && Array.isArray(body[lineSubform]) ? `?$expand=${lineSubform}` : undefined;
      return client.get(form, keys, query, { cache: false });
    },
    body,
  );
}
/** An inserted line must return a row identity; a matching older line alone is insufficient. */
export function verifyLineCreate(
  client: PriorityClient,
  form: string,
  key: RecordKey,
  subform: string,
  body: Record<string, unknown>,
) {
  return verifyWrite(
    () => client.addLine(form, key, subform, body),
    async (result) => {
      if (!result || typeof result !== 'object')
        throw new Error('POST returned no line identity; inspect the sub-form before retrying.');
      const row = result as Record<string, unknown>;
      const id = (
        subform.includes('EXTFILE') ? ['EXTFILENUM', 'KLINE'] : ['KLINE', 'EXTFILENUM']
      ).find((k) => typeof row[k] === 'number' || typeof row[k] === 'string');
      if (!id)
        throw new Error(
          'POST returned no supported line identity; inspect the sub-form before retrying.',
        );
      return client.getSubformRow(
        form,
        key,
        subform,
        { [id]: row[id] as string | number },
        undefined,
        { cache: false },
      );
    },
    body,
  );
}
