import { PriorityError } from '../client/errors.js';
import type { PriorityClient } from '../client/priority-client.js';
import { parseCsdl } from './csdl.js';
import { getSchema } from './priority-schema.js';

export type NamedKeys = Record<string, string | number>;
export type RecordKey = string | NamedKeys;
const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
export function validateNamedKeys(keys: NamedKeys, expected?: string[]): void {
  if (!keys || typeof keys !== 'object' || Array.isArray(keys) || !Object.keys(keys).length)
    throw new PriorityError('keys must be a non-empty object.', 400);
  for (const [name, value] of Object.entries(keys)) {
    if (
      !identifier.test(name) ||
      !(typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value)))
    )
      throw new PriorityError(
        'Key names must be identifiers and values strings or finite numbers.',
        400,
      );
  }
  if (
    expected &&
    (expected.length !== Object.keys(keys).length || expected.some((k) => !Object.hasOwn(keys, k)))
  )
    throw new PriorityError(`Expected exactly these key fields: ${expected.join(', ')}.`, 400);
}
/** Exactly one key form. Real named-key requests require known schema or parsed metadata. */
export async function resolveRecordKey(
  client: PriorityClient,
  form: string,
  key?: string,
  keys?: NamedKeys,
  preview = false,
): Promise<RecordKey> {
  if ((key !== undefined) === (keys !== undefined))
    throw new PriorityError('Provide exactly one of key or keys.', 400);
  const known = getSchema(form)?.key;
  if (key !== undefined) {
    if (!key.length) throw new PriorityError('key cannot be empty.', 400);
    if (known && known.length > 1)
      throw new PriorityError(`${form} requires keys: ${known.join(', ')}.`, 400);
    return key;
  }
  if (!keys) throw new PriorityError('Provide keys.', 400);
  validateNamedKeys(keys);
  let expected = known;
  if (!expected && !preview) {
    expected = parseCsdl(await client.getMetadataFor(form), form)?.key;
    if (!expected?.length)
      throw new PriorityError(`Cannot validate key fields for ${form}; inspect its metadata.`, 400);
  }
  validateNamedKeys(keys, expected);
  return keys;
}
