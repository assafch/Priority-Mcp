import { PriorityError } from '../client/errors.js';

/**
 * Fields that only a Priority procedure may set.
 *
 * FINAL is written by the document's close procedure ("סגירת חשבונית" — CLOSEANINVOICE, run on the
 * invoice form through the Priority Web SDK). The procedure assigns the final number, posts the
 * journal entry (FNCNUM / IVFNCTRANS_SUBFORM) and moves stock. A direct OData write of the same
 * field does none of that: Priority flips the flag and then refuses every further update
 * ("לא ניתן לעדכן מסמך סופי"). That is how EINVOICES T164 (25.10.2026) and T173 (2.11.2026) ended
 * up final-but-draft with no journal; only Priority support can clear the flag (ticket
 * SCI26096671). This tenant's $metadata exposes no OData action for the close (checked 4.11.2026),
 * so there is no legitimate reason for any write to carry the field — in either direction
 * (clearing it is just as much a field write as setting it), in the body or as the URL target
 * (OData also addresses a single property as …/EINVOICES('T173')/FINAL or …/FINAL/$value).
 */
export const PROCEDURE_ONLY_FIELDS: ReadonlySet<string> = new Set(['FINAL']);

export const PROCEDURE_ONLY_FIELD_CODE = 'PROCEDURE_ONLY_FIELD';

const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'MERGE']);

/**
 * Priority field names are [A-Z0-9_]. Fold case, decompose accents and ligatures (NFKD) and drop
 * every other character, so "final", "FINAL " or a zero-width-spaced spelling all compare as FINAL.
 */
export function canonicalFieldName(key: string): string {
  return key
    .normalize('NFKD')
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '');
}

function isProcedureOnly(name: string): boolean {
  return PROCEDURE_ONLY_FIELDS.has(canonicalFieldName(name));
}

/**
 * The body exactly as it will go on the wire: one JSON round trip resolves toJSON(), getters and
 * proxies, so the object that is inspected is the object that is serialized.
 */
export function wireBody(body: unknown): unknown {
  if (body === undefined) return undefined;
  const text = JSON.stringify(body);
  return text === undefined ? undefined : JSON.parse(text);
}

/**
 * Path of the first procedure-only key in a write body, or null. Looks through nested objects
 * and arrays (OData deep-insert lines), matches the key name canonically, ignores values.
 */
export function findProcedureOnlyField(body: unknown, path = ''): string | null {
  if (Array.isArray(body)) {
    for (let i = 0; i < body.length; i++) {
      const element = body[i];
      const hit = findProcedureOnlyField(
        element,
        `${path}[${i}]${Array.isArray(element) ? '' : '.'}`,
      );
      if (hit) return hit;
    }
    return null;
  }
  if (!body || typeof body !== 'object') return null;
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (isProcedureOnly(key)) return `${path}${key}`;
    const hit = findProcedureOnlyField(
      value,
      Array.isArray(value) ? `${path}${key}` : `${path}${key}.`,
    );
    if (hit) return hit;
  }
  return null;
}

/**
 * The procedure-only property a request URL (or relative OData path) addresses directly —
 * …/EINVOICES('T173')/FINAL, …/FINAL/$value — or null. Key predicates are ignored, so
 * EINVOICES(IVNUM='T173',…) itself never matches.
 */
export function findProcedureOnlyPath(target: string | undefined): string | null {
  if (!target) return null;
  let path = target.split(/[?#]/, 1)[0];
  try {
    path = decodeURIComponent(path);
  } catch {
    // keep the raw path; an undecodable segment cannot name a field either way
  }
  for (const segment of path.split('/')) {
    const name = segment.replace(/\(.*$/s, '');
    if (name && isProcedureOnly(name)) return segment;
  }
  return null;
}

function offence(
  method: string,
  body: unknown,
  target?: string,
): { hit: string; where: 'path' | 'body' } | null {
  if (!MUTATING.has(method.toUpperCase())) return null;
  const inPath = findProcedureOnlyPath(target);
  if (inPath) return { hit: inPath, where: 'path' };
  if (body == null) return null;
  const inBody = findProcedureOnlyField(wireBody(body));
  return inBody ? { hit: inBody, where: 'body' } : null;
}

export function procedureOnlyFieldMessage(
  method: string,
  hit: string,
  target?: string,
  where: 'path' | 'body' = 'body',
): string {
  const field = canonicalFieldName(hit.split('.').pop() ?? hit) || hit;
  return [
    `Blocked: ${method}${target ? ` ${target}` : ''} ${where === 'path' ? 'targets' : 'writes'} "${hit}".`,
    `${field} is set only by Priority's close procedure ("סגירת חשבונית", CLOSEANINVOICE, run on the invoice form through the Web SDK).`,
    'A direct write marks the document final with no journal entry, no final number and no stock movement, and Priority then locks it ("לא ניתן לעדכן מסמך סופי") — EINVOICES T164 and T173, ticket SCI26096671.',
    'Nothing was sent. Close the document with the procedure instead.',
  ].join(' ');
}

/** Throw a 400 PriorityError when a mutating request carries a procedure-only field (body or URL). */
export function assertNoProcedureOnlyField(method: string, body: unknown, target?: string): void {
  const found = offence(method, body, target);
  if (!found) return;
  throw new PriorityError(
    procedureOnlyFieldMessage(method, found.hit, target, found.where),
    400,
    PROCEDURE_ONLY_FIELD_CODE,
    'Run the close procedure (CLOSEANINVOICE) on the document instead of writing FINAL.',
  );
}

/**
 * Tool-level gate: the blocked result to return instead of a dry-run preview or a write, or null
 * when the request is clean. Returned (not thrown) so a confirm=false / dryRun preview also says
 * "blocked" rather than showing a wouldSend that could never be sent.
 */
export function blockProcedureOnlyField(method: string, target: string, body: unknown) {
  const found = offence(method, body, target);
  if (!found) return null;
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          status: 'blocked',
          acknowledged: false,
          verified: false,
          verification: { reason: 'Procedure-only field in the write request; nothing was sent.' },
          field: found.hit,
          error: procedureOnlyFieldMessage(method, found.hit, target, found.where),
        }),
      },
    ],
    isError: true as const,
  };
}
