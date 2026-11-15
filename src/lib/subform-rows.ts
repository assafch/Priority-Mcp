import { PriorityError } from '../client/errors.js';
import type { PriorityClient } from '../client/priority-client.js';
import { parseCsdl } from './csdl.js';
import { type NamedKeys, validateNamedKeys } from './record-key.js';

/**
 * Key fields of one sub-form's rows.
 *
 * A sub-form name (PORDERITEMS_SUBFORM) is a NAVIGATION PROPERTY of its parent, not an entity:
 * GetMetadataFor(entity='PORDERITEMS_SUBFORM') answers HTTP 500 "entity PORDERITEMS_SUBFORM not
 * found: parse metadata … XML decode: EOF" (seen live 15.11.2026 — it blocked every confirmed
 * priority_update_line before the PATCH was even sent). The row type is declared on the parent
 * (PORDERS → PORDERITEMS_SUBFORM: PORDERITEMS), and that type's own metadata carries the key.
 */
export async function subformKeyFields(
  client: PriorityClient,
  form: string,
  subform: string,
): Promise<string[]> {
  const parent = parseCsdl(await client.getMetadataFor(form), form);
  if (parent && !parent.subforms.includes(subform))
    throw new PriorityError(
      `${form} has no sub-form ${subform}. Its sub-forms: ${parent.subforms.join(', ') || 'none'}.`,
      400,
    );
  const type = parent?.subformTypes?.[subform] ?? subform.replace(/_SUBFORM$/, '');
  const key = parseCsdl(await client.getMetadataFor(type), type)?.key;
  if (!key?.length)
    throw new PriorityError(
      `Cannot read the key fields of ${form}/${subform} (row type ${type}); inspect its metadata.`,
      400,
    );
  return key;
}

/** Validate caller-supplied row keys against the sub-form's real key fields. */
export async function resolveSubformRowKeys(
  client: PriorityClient,
  form: string,
  subform: string,
  lineKeys: NamedKeys,
): Promise<{ lineKeys: NamedKeys; keyFields: string[] }> {
  validateNamedKeys(lineKeys);
  const keyFields = await subformKeyFields(client, form, subform);
  validateNamedKeys(lineKeys, keyFields);
  return { lineKeys, keyFields };
}

export interface DraftCheck {
  draft: boolean;
  reason: string;
  state: Record<string, unknown>;
}

const isSet = (v: unknown) => v !== null && v !== undefined && v !== '' && v !== 0;

/**
 * Is this parent document provably still a draft? Fails closed.
 *
 * Forms that carry FINAL (invoices): FINAL empty, no journal entry (FNCNUM) and not cancelled.
 * Forms without FINAL (orders, import files): only the draft status טיוטא counts, and nothing
 * closed. Anything else is treated as final: a row is never deleted from it.
 */
export function checkDraft(record: Record<string, unknown>): DraftCheck {
  const state: Record<string, unknown> = {};
  for (const f of ['STATDES', 'FINAL', 'FNCNUM', 'STORNOFLAG', 'CLOSED', 'CLOSEDBOOL'])
    if (Object.hasOwn(record, f)) state[f] = record[f];
  const no = (reason: string): DraftCheck => ({ draft: false, reason, state });
  if (record.FINAL === 'Y') return no('The document is final (FINAL=Y).');
  if (isSet(record.FNCNUM)) return no(`The document has a journal entry (${record.FNCNUM}).`);
  if (record.STORNOFLAG === 'Y') return no('The document is cancelled (storno).');
  if (record.CLOSED === 'Y' || record.CLOSEDBOOL === 'Y') return no('The document is closed.');
  if (Object.hasOwn(record, 'FINAL'))
    return { draft: true, reason: 'FINAL is empty and there is no journal entry.', state };
  if (record.STATDES === 'טיוטא') return { draft: true, reason: 'Status is טיוטא (draft).', state };
  return no(
    `The form has no FINAL field and its status is ${
      isSet(record.STATDES) ? `"${record.STATDES}"` : 'unknown'
    }, not טיוטא — it cannot be shown to be a draft.`,
  );
}

/** Attachment rows carry the whole file in EXTFILENAME; never pull it just to look at a row. */
export function rowSelectFor(subform: string): string | undefined {
  return /EXTFILE/i.test(subform)
    ? '?$select=EXTFILENUM,EXTFILEDES,SUFFIX,FILESIZE,CURDATE'
    : undefined;
}

export interface DeleteOutcome {
  status: 'verified' | 'unverified' | 'unknown' | 'failed';
  acknowledged: boolean;
  verified: boolean;
  verification: {
    rowsBefore?: number;
    rowsAfter?: number;
    rowStillPresent?: boolean;
    reason: string;
  };
}

const sameRow = (row: Record<string, unknown>, keys: NamedKeys) =>
  Object.entries(keys).every(([k, v]) => String(row[k]) === String(v));

/**
 * DELETE one sub-form row and prove it: the row was there, it is gone afterwards, and the row
 * count dropped by exactly one. Never resubmits. The caller has already checked the parent is a
 * draft and that `lineKeys` are the sub-form's real key fields.
 */
export async function deleteRowVerified(
  client: PriorityClient,
  form: string,
  key: string | NamedKeys,
  subform: string,
  lineKeys: NamedKeys,
  keyFields: string[],
): Promise<DeleteOutcome> {
  const list = async () =>
    (
      await client.listSubform<Record<string, unknown>>(
        form,
        key,
        subform,
        `?$select=${keyFields.join(',')}&$top=1000`,
        { cache: false },
      )
    ).value;
  const before = await list();
  if (!before.some((r) => sameRow(r, lineKeys)))
    return {
      status: 'failed',
      acknowledged: false,
      verified: false,
      verification: {
        rowsBefore: before.length,
        reason: 'The row is not on the document; nothing was sent.',
      },
    };
  try {
    await client.deleteSubformRow(form, key, subform, lineKeys);
  } catch (error) {
    const code = error instanceof PriorityError ? error.statusCode : undefined;
    const rejected = code !== undefined && code >= 400 && code < 500 && code !== 408;
    return {
      status: rejected ? 'failed' : 'unknown',
      acknowledged: false,
      verified: false,
      verification: {
        rowsBefore: before.length,
        reason: `${rejected ? 'Priority refused the delete' : 'The delete did not finish cleanly; re-read the document before trying again'}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      },
    };
  }
  try {
    const after = await list();
    const rowStillPresent = after.some((r) => sameRow(r, lineKeys));
    const verified = !rowStillPresent && after.length === before.length - 1;
    return {
      status: verified ? 'verified' : 'unverified',
      acknowledged: true,
      verified,
      verification: {
        rowsBefore: before.length,
        rowsAfter: after.length,
        rowStillPresent,
        reason: verified
          ? 'The row is gone and the row count dropped by exactly one.'
          : 'Priority acknowledged the delete but the re-read does not show exactly one row less.',
      },
    };
  } catch (error) {
    return {
      status: 'unverified',
      acknowledged: true,
      verified: false,
      verification: {
        rowsBefore: before.length,
        reason: `Delete acknowledged; re-read unavailable: ${error instanceof Error ? error.message : String(error)}`,
      },
    };
  }
}
