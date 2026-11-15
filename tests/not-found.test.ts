import { describe, expect, it } from 'vitest';
import { PriorityError, notFoundMessage, toMcpError } from '../src/client/errors.js';
import { aliasHint } from '../src/lib/form-aliases.js';

/**
 * A 404 on this API is three different, individually fixable things, and Priority distinguishes
 * them only by the response body. Shapes below are copied from live responses (company a051014,
 * 2026-07-29) — see notFoundMessage()'s doc comment.
 */
describe('notFoundMessage', () => {
  it('explains an absent entity set (empty body, no key predicate)', () => {
    const err = new PriorityError('', 404, undefined, undefined, undefined, undefined, {
      form: 'GLPERIODS',
      keyed: false,
    });
    const msg = notFoundMessage(err);
    expect(msg).toContain("'GLPERIODS'");
    expect(msg).toContain('service document');
    // Must not read as a permission problem — that condition is a 400, not a 404.
    expect(msg).toContain('400');
    expect(msg).toContain('priority_list_forms');
  });

  it('offers the alias for a known wrong name', () => {
    const err = new PriorityError('', 404, undefined, undefined, undefined, undefined, {
      form: 'GLPERIODS',
      keyed: false,
    });
    expect(notFoundMessage(err)).toContain('ACCDATES');
  });

  it('names the sub-form when a sub-form was mistaken for a table', () => {
    const err = new PriorityError('', 404, undefined, undefined, undefined, undefined, {
      form: 'IMPFILEITEMS',
      keyed: false,
    });
    expect(notFoundMessage(err)).toContain('IMPFILEITEMS_SUBFORM');
  });

  it('diagnoses a composite-keyed form hit with a single-value key (empty body)', () => {
    const err = new PriorityError('', 404, undefined, undefined, undefined, undefined, {
      form: 'PINVOICES',
      keyed: true,
    });
    const msg = notFoundMessage(err);
    expect(msg).toContain('COMPOSITE');
    expect(msg).toContain('priority_query');
    // The name is fine here, so it must NOT claim the form is missing.
    expect(msg).not.toContain('is not in this installation');
  });

  it('reports a bad key on a known form without blaming the form name', () => {
    const err = new PriorityError(
      'The specified entity was not found',
      404,
      undefined,
      undefined,
      '{"error":{"message":"The specified entity was not found"}}',
      undefined,
      { form: 'IMPFILES', keyed: true },
    );
    const msg = notFoundMessage(err);
    expect(msg).toContain('no record with that key');
    expect(msg).not.toContain('service document');
  });

  it('still works when the resource could not be parsed from the URL', () => {
    const msg = notFoundMessage(new PriorityError('', 404));
    expect(msg).toContain('the requested entity');
    expect(msg).toContain('priority_list_forms');
  });

  it('keeps carrying an explicit suggestion (back-compat)', () => {
    const err = new PriorityError('not found', 404, undefined, 'Try searching first');
    expect(toMcpError(err).message).toContain('Try searching first');
  });
});

describe('aliasHint', () => {
  it('maps every documented 404 mistake to a real form or sub-form', () => {
    for (const name of [
      'GLPERIODS',
      'LOGCOUNTERS',
      'WARHSBAL',
      'PARTBALANCE',
      'LOCWARHSBAL',
      'CASHACC',
      'IMPFILEITEMS',
      'COSTINGLOGCOUNTS',
      'TRANSIMPFILE',
    ]) {
      expect(aliasHint(name), name).toBeTruthy();
    }
  });

  it('distinguishes an API-flag-off form from a missing one', () => {
    const hint = aliasHint('COMPANIES');
    expect(hint).toContain('DOES exist');
    expect(hint).toContain('Available for API');
  });

  it('is case-insensitive and silent on unknown names', () => {
    expect(aliasHint('glperiods')).toContain('ACCDATES');
    expect(aliasHint('CUSTOMERS')).toBeUndefined();
    expect(aliasHint(undefined)).toBeUndefined();
  });
});

describe('hint for the opaque XML $select error', () => {
  // Live repro (2026-07-29): ACCOUNTS?$select=ZZZNOPE and PINVOICES?$select=VATFLAG both return
  // this message, while PINVOICES?$filter=VATFLAG eq 'Y' returns 200.
  const XML_ERR = 'היתה בעיה ביצירת ה-XML. כפי הנראה באחד השדות קיים ערך שאינו תקין.';

  it('explains that a $select field is not selectable, and names the form', () => {
    const err = new PriorityError(XML_ERR, 400, undefined, undefined, undefined, undefined, {
      form: 'PINVOICES',
      keyed: false,
    });
    const msg = toMcpError(err).message;
    expect(msg).toContain('$select');
    expect(msg).toContain('PINVOICES');
    expect(msg).toContain('filtering');
  });

  it('works without a parsed form name', () => {
    const msg = toMcpError(new PriorityError(XML_ERR, 400)).message;
    expect(msg).toContain('priority_get_entity_metadata');
  });

  it('does not swallow the API-flag-off 400', () => {
    const err = new PriorityError(
      'לא ניתן להפעיל API למסך זה.',
      400,
      undefined,
      undefined,
      undefined,
      undefined,
      { form: 'COMPANIES', keyed: false },
    );
    const msg = toMcpError(err).message;
    expect(msg).toContain('COMPANIES');
    expect(msg).toContain('Available for API');
    expect(msg).toContain('NOT a 404');
  });
});
