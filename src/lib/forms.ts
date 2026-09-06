/**
 * Form discovery and per-form capability checks.
 *
 * Three facts about THIS Priority OData API drive everything here:
 *   1. The service document lists 1371 forms and takes ~65s to fetch (measured live on company
 *      a051014, 2026-07-29) — far too slow to sit behind an error path or a per-call check, so it
 *      is memoized process-wide for much longer than the client's 60s response cache.
 *   2. "Form exists" and "form answers the API" are DIFFERENT things: an unexposed name 404s with
 *      an empty body, while an existing-but-unflagged form answers 400 "לא ניתן להפעיל API למסך זה".
 *      Tools that degrade gracefully must tell those apart, hence probeForm().
 *   3. A single `?$top=1` GET is cheap (~1-2s) and answers both questions at once, so runtime
 *      capability detection is preferred over hardcoding what a given installation can do.
 */

import { PriorityError } from '../client/errors.js';
import type { PriorityClient } from '../client/priority-client.js';
import { parseCsdl } from './csdl.js';

export interface ExposedForm {
  name: string;
  kind?: string;
  url?: string;
}

/** How long a discovered form list / probe verdict stays fresh (ms). */
const FORM_LIST_TTL_MS = 15 * 60 * 1000;
const PROBE_TTL_MS = 5 * 60 * 1000;

let formCache: { at: number; forms: ExposedForm[] } | undefined;
let inFlight: Promise<ExposedForm[]> | undefined;
const probeCache = new Map<string, { at: number; probe: FormProbe }>();

/** Test hook: drop every memoized discovery result. */
export function _resetFormCaches(): void {
  formCache = undefined;
  inFlight = undefined;
  probeCache.clear();
}

/**
 * The forms this installation exposes to the API, from the OData service document. Memoized for
 * FORM_LIST_TTL_MS; concurrent callers share one in-flight request (the fetch is ~65s here, so a
 * stampede would be brutal).
 */
export async function listExposedForms(client: PriorityClient): Promise<ExposedForm[]> {
  if (formCache && Date.now() - formCache.at < FORM_LIST_TTL_MS) return formCache.forms;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const doc = await client.serviceRoot<{ value?: Array<Record<string, unknown>> }>();
    const forms = (doc.value ?? []).map((f) => ({
      name: String(f.name ?? f.url ?? ''),
      kind: f.kind === undefined ? undefined : String(f.kind),
      url: f.url === undefined ? undefined : String(f.url),
    }));
    formCache = { at: Date.now(), forms };
    return forms;
  })();
  try {
    return await inFlight;
  } finally {
    inFlight = undefined;
  }
}

/** The cached form list if we already have one — never triggers the slow fetch. */
export function cachedExposedForms(): ExposedForm[] | undefined {
  return formCache && Date.now() - formCache.at < FORM_LIST_TTL_MS ? formCache.forms : undefined;
}

export interface FormFilter {
  prefix?: string;
  contains?: string;
  limit?: number;
}

/**
 * Narrow a form list at the source. Matching is case-insensitive (Priority form names are
 * UPPERCASE, but callers type lowercase). Returns the matches plus the counts needed to tell the
 * caller honestly whether they are seeing everything.
 */
export function filterForms<T extends { name: string }>(
  forms: T[],
  filter: FormFilter,
): { matches: T[]; total: number; matched: number; truncated: boolean } {
  const prefix = filter.prefix?.toUpperCase();
  const contains = filter.contains?.toUpperCase();
  const matched = forms.filter((f) => {
    const n = f.name.toUpperCase();
    if (prefix && !n.startsWith(prefix)) return false;
    if (contains && !n.includes(contains)) return false;
    return true;
  });
  const limit = filter.limit ?? matched.length;
  return {
    matches: matched.slice(0, limit),
    total: forms.length,
    matched: matched.length,
    truncated: matched.length > limit,
  };
}

export type FormStatus = 'ok' | 'api-flag-off' | 'absent' | 'error';

export interface FormProbe {
  form: string;
  status: FormStatus;
  /** Human-readable reason, always populated for non-ok verdicts. */
  detail?: string;
  /** Row count returned by the probe query (status 'ok' only). */
  rows?: number;
  /** Field names seen on the sampled row (status 'ok' only). */
  fields?: string[];
}

/** Does this 400 mean "the form exists but its Available-for-API flag is off"? */
export function isApiFlagOffError(err: unknown): boolean {
  if (!(err instanceof PriorityError) || err.statusCode !== 400) return false;
  const body = typeof err.body === 'string' ? err.body : JSON.stringify(err.body ?? '');
  const hay = `${err.message} ${body}`.toLowerCase();
  return hay.includes('להפעיל api') || /cannot (enable|activate) (the )?api/i.test(hay);
}

/**
 * Ask the installation directly what it can do with a form: read one row and classify the answer.
 * Cheap (~1-2s) and definitive, so tools can detect capability at runtime instead of hardcoding a
 * refusal. Verdicts are memoized for PROBE_TTL_MS — long enough to keep a multi-candidate check
 * fast, short enough that an admin flipping the API flag is picked up within the same session.
 */
export async function probeForm(
  client: PriorityClient,
  form: string,
  query = '?$top=1',
): Promise<FormProbe> {
  const cached = probeCache.get(form);
  if (cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.probe;

  let probe: FormProbe;
  try {
    const res = await client.list<Record<string, unknown>>(form, query);
    const rows = res.value ?? [];
    probe = {
      form,
      status: 'ok',
      rows: rows.length,
      fields: rows[0] ? Object.keys(rows[0]) : [],
    };
  } catch (err) {
    if (isApiFlagOffError(err)) {
      probe = {
        form,
        status: 'api-flag-off',
        detail: `'${form}' exists on this installation but its "Available for API" flag is off (400 "לא ניתן להפעיל API למסך זה"). A Priority admin must tick it in the API/Limited-Access Forms screen.`,
      };
    } else if (err instanceof PriorityError && err.statusCode === 404) {
      probe = {
        form,
        status: 'absent',
        detail: `'${form}' is not in this installation's OData service document (404) — the name does not exist here as an entity set.`,
      };
    } else {
      probe = {
        form,
        status: 'error',
        detail: err instanceof Error ? err.message : String(err),
      };
    }
  }
  probeCache.set(form, { at: Date.now(), probe });
  return probe;
}

/** Probe several candidates in order and return the first that answers, plus every verdict. */
export async function probeCandidates(
  client: PriorityClient,
  candidates: string[],
  query = '?$top=1',
): Promise<{ working?: FormProbe; probes: FormProbe[] }> {
  const probes: FormProbe[] = [];
  for (const form of candidates) {
    const probe = await probeForm(client, form, query);
    probes.push(probe);
    if (probe.status === 'ok') return { working: probe, probes };
  }
  return { probes };
}

/**
 * The navigation properties (sub-forms) a form exposes, from GetMetadataFor. Returns null when the
 * metadata call fails or the form isn't in it — callers then say so rather than guessing a name.
 */
export async function formSubforms(client: PriorityClient, form: string): Promise<string[] | null> {
  try {
    // GetMetadataFor normally answers CSDL XML, but $metadata is known to flip to CSDL JSON on
    // this server — parse either rather than assuming (a wrong assumption here would silently
    // disable attachment support).
    const metadata = await client.getMetadataFor<unknown>(form);
    return parseCsdl(metadata, form)?.subforms ?? null;
  } catch {
    return null;
  }
}

/**
 * Find the attachments sub-form of a document form AT RUNTIME. Most forms use EXTFILES_SUBFORM,
 * but not all (LOGPART uses PARTEXTFILE_SUBFORM), and some forms have none at all (verified:
 * CUSTOMERS has no EXTFILES_SUBFORM on this install — it 400s with "Could not find a property
 * named 'EXTFILES_SUBFORM'"). Matching on the EXTFILE stem covers both spellings without
 * hardcoding a per-form table.
 */
export async function attachmentSubformOf(
  client: PriorityClient,
  form: string,
): Promise<{ subform: string | null; subforms: string[] | null }> {
  const subforms = await formSubforms(client, form);
  if (!subforms) return { subform: null, subforms: null };
  const exact = subforms.find((s) => s === 'EXTFILES_SUBFORM');
  const stem = subforms.find((s) => /EXTFILE/i.test(s));
  return { subform: exact ?? stem ?? null, subforms };
}
