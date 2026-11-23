import { PriorityError } from '../client/errors.js';
import { canonicalFieldName, wireBody } from './procedure-only-fields.js';

/**
 * Import-file stage lock.
 *
 * Two kinds of write must never leave this process as a plain field write:
 *
 *  1. A status change of an import file (IMPFILES.CLOSED / IMPFILES.STATDES). Closing and
 *     reopening are the screen procedures "סגירת התיק" (IMPFILE1) and "ביטול סגירה של התיק"
 *     (OPENIMPFILE). A field write skips every check of the mandatory order
 *     (receipt into BONDED → detail → loading calc → close → release → per-line costs → costing).
 *  2. Any write to a bonded release (DOCUMENTS_J, header or lines). Priority's procedure (SOP
 *     LBI2400656, step ד׳ 13–15) registers the per-line import costs ("רישום עלויות יבוא לשורה",
 *     IMPORTCOSTPERLINE) on the release while it is still a draft and the file is closed, and only
 *     then makes it final. Some early releases were made final without that step and
 *     got their costs only later. No tool here does the whole sequence yet.
 *
 * The check sits in PriorityClient.send, next to the FINAL guard, so every write path is covered:
 * curated tools, generic tools and scripts that import the client.
 */
export const IMPORT_STAGE_GUARD_CODE = 'IMPORT_STAGE_GUARD';

export const DRAFT_FILE_STATUS = 'טיוטא';

export type StageViolation = {
  rule: 'impfile-status' | 'bonded-release';
  field?: string;
  message: string;
};

const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'MERGE', 'DELETE']);
const STATUS_FIELDS = new Set(['CLOSED', 'STATDES']);

function statusMessage(method: string, target: string): string {
  return `Blocked: ${method} ${target} would change an import file's status. Closing and reopening an import file are screen procedures ("סגירת התיק" / "ביטול סגירה של התיק"); a field write skips the checks of the mandatory order (receipt → detail → calc → close → release → line costs → costing). Nothing was sent.`;
}

function releaseMessage(method: string, target: string): string {
  return `Blocked: ${method} ${target} writes a bonded release (קבלות סחורה ממחסן ערובה). Priority's procedure (SOP LBI2400656, step ד׳ 13–15) is: fill the release, run "רישום עלויות יבוא לשורה" while the file is closed and the release is still a draft, check the costs, and only then set it final. Some early releases were made final without that step and got their costs only later. Releases are done in the screen until a dedicated tool does all of it. Nothing was sent.`;
}

/** Path segments of a request URL or relative OData path, decoded, without query or fragment. */
function pathSegments(target: string): string[] {
  let path = target.split(/[?#]/, 1)[0];
  try {
    path = decodeURIComponent(path);
  } catch {
    // keep the raw path; an undecodable segment cannot name a form either way
  }
  return path.split('/').filter(Boolean);
}

/** Entity or property name of a segment: the text before its key predicate. */
function segmentName(segment: string): string {
  return segment.replace(/\(.*$/s, '').trim();
}

/** The violation a mutating request commits, or null. Reads never match. */
export function findStageViolation(
  method: string,
  target: string | undefined,
  body: unknown,
): StageViolation | null {
  const verb = method.toUpperCase();
  if (!MUTATING.has(verb) || !target) return null;
  const segments = pathSegments(target);
  const names = segments.map(segmentName);

  if (names.includes('DOCUMENTS_J')) {
    return { rule: 'bonded-release', message: releaseMessage(verb, target) };
  }

  const at = names.lastIndexOf('IMPFILES');
  if (at < 0) return null;
  const rest = names.slice(at + 1);
  const hasKey = segments[at].includes('(');

  // …/IMPFILES('X')/CLOSED or …/STATDES[/$value]: the property addressed in the URL.
  if (rest.length >= 1) {
    const field = canonicalFieldName(rest[0]);
    const tail = rest.slice(1);
    const onlyValue = tail.length === 0 || (tail.length === 1 && tail[0] === '$value');
    if (STATUS_FIELDS.has(field) && onlyValue) {
      return { rule: 'impfile-status', field, message: statusMessage(verb, target) };
    }
    return null; // a sub-form of the file (IMPFILEITEMS_SUBFORM, …) is not the header
  }

  const wire = wireBody(body);
  if (!wire || typeof wire !== 'object' || Array.isArray(wire)) return null;
  const hits = new Map<string, unknown>();
  for (const [key, value] of Object.entries(wire as Record<string, unknown>)) {
    const field = canonicalFieldName(key);
    if (STATUS_FIELDS.has(field)) hits.set(field, value);
  }
  if (hits.has('CLOSED')) {
    return { rule: 'impfile-status', field: 'CLOSED', message: statusMessage(verb, target) };
  }
  if (hits.has('STATDES')) {
    const openingDraft = verb === 'POST' && !hasKey && hits.get('STATDES') === DRAFT_FILE_STATUS;
    if (!openingDraft) {
      return { rule: 'impfile-status', field: 'STATDES', message: statusMessage(verb, target) };
    }
  }
  return null;
}

/** Throw a 400 PriorityError when a mutating request breaks the stage lock. */
export function assertNoStageViolation(method: string, body: unknown, target?: string): void {
  const found = findStageViolation(method, target, body);
  if (!found) return;
  throw new PriorityError(
    found.message,
    400,
    IMPORT_STAGE_GUARD_CODE,
    found.rule === 'impfile-status'
      ? 'Use impfile_close / impfile_reopen to see what is missing; the close itself is done in the Priority screen.'
      : 'Use bonded_release_guide for the screen steps and bonded_line_costs_guide to verify the costs.',
  );
}

/**
 * Tool-level gate: the blocked result to return instead of a dry-run preview or a write, or null
 * when the request is clean — so a preview also says "blocked" rather than showing a body that
 * could never be sent.
 */
export function blockStageViolation(method: string, target: string, body: unknown) {
  const found = findStageViolation(method, target, body);
  if (!found) return null;
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({
          status: 'blocked',
          acknowledged: false,
          verified: false,
          verification: { reason: 'Import-file stage lock; nothing was sent.' },
          rule: found.rule,
          field: found.field ?? null,
          error: found.message,
        }),
      },
    ],
    isError: true as const,
  };
}
