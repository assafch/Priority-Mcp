import { describe, expect, it } from 'vitest';
import { ODataBuilder, odataLiteral } from '../src/client/odata-builder.js';

describe('odataLiteral', () => {
  it('quotes strings and doubles embedded single quotes', () => {
    expect(odataLiteral('active')).toBe("'active'");
    expect(odataLiteral("O'Brien")).toBe("'O''Brien'");
  });
  it('emits numbers bare with a dot separator', () => {
    expect(odataLiteral(100)).toBe('100');
    expect(odataLiteral(99.5)).toBe('99.5');
  });
  it('emits booleans as true/false', () => {
    expect(odataLiteral(true)).toBe('true');
    expect(odataLiteral(false)).toBe('false');
  });
  it('emits dates as unquoted ISO 8601', () => {
    expect(odataLiteral(new Date('2026-05-01T00:00:00Z'))).toBe('2026-05-01T00:00:00.000Z');
  });
  it('emits FULL datetimeoffset STRINGS unquoted (the path domain tools use via dates.ts)', () => {
    expect(odataLiteral('2026-05-01T00:00:00Z')).toBe('2026-05-01T00:00:00Z');
    expect(odataLiteral('2026-05-01T00:00:00+02:00')).toBe('2026-05-01T00:00:00+02:00');
  });
  it('QUOTES bare dates and offset-less datetimes as strings (date-coded values must not become literals)', () => {
    // A date-coded part/lot number must be a string, not `PARTNAME eq 2026-05-01` (a 400).
    expect(odataLiteral('2026-05-01')).toBe("'2026-05-01'");
    expect(odataLiteral('2026-05-01T00:00:00')).toBe("'2026-05-01T00:00:00'"); // no offset
  });
  it('still quotes non-date strings', () => {
    expect(odataLiteral('2026-05')).toBe("'2026-05'");
    expect(odataLiteral('SO24000001')).toBe("'SO24000001'");
  });
});

describe('ODataBuilder', () => {
  it('builds empty query', () => {
    expect(new ODataBuilder().build()).toBe('');
  });

  it('builds $top and $skip', () => {
    expect(new ODataBuilder().top(10).skip(20).build()).toBe('?$top=10&$skip=20');
  });

  it('percent-encodes filter values but keeps $keys and operators readable after decode', () => {
    const q = new ODataBuilder().eq('STATDES', 'active').build();
    expect(q).toBe("?$filter=STATDES%20eq%20'active'");
    expect(decodeURIComponent(q)).toBe("?$filter=STATDES eq 'active'");
  });

  it('keeps numbers unquoted', () => {
    expect(new ODataBuilder().eq('CUSTBALANCE', 100).build()).toBe(
      '?$filter=CUSTBALANCE%20eq%20100',
    );
  });

  it('encodes decimals with a dot separator', () => {
    expect(new ODataBuilder().gt('TOTPRICE', 1000.5).build()).toBe(
      '?$filter=TOTPRICE%20gt%201000.5',
    );
  });

  it('doubles and preserves single quotes through encoding', () => {
    const q = new ODataBuilder().eq('CUSTDES', "O'Brien").build();
    expect(q).toBe("?$filter=CUSTDES%20eq%20'O''Brien'");
    expect(decodeURIComponent(q)).toBe("?$filter=CUSTDES eq 'O''Brien'");
  });

  it('encodes spaces inside string values', () => {
    expect(new ODataBuilder().eq('CUSTDES', 'Acme Corp').build()).toBe(
      "?$filter=CUSTDES%20eq%20'Acme%20Corp'",
    );
  });

  it('percent-encodes Hebrew values', () => {
    const q = new ODataBuilder().contains('CUSTDES', 'לקוח').build();
    expect(q).toBe("?$filter=contains(CUSTDES%2C'%D7%9C%D7%A7%D7%95%D7%97')");
    expect(decodeURIComponent(q)).toBe("?$filter=contains(CUSTDES,'לקוח')");
  });

  it('emits unquoted ISO dates in filters', () => {
    const q = new ODataBuilder().ge('CURDATE', new Date('2026-05-01T00:00:00Z')).build();
    expect(decodeURIComponent(q)).toBe('?$filter=CURDATE ge 2026-05-01T00:00:00.000Z');
  });

  it('emits unquoted datetimeoffset STRINGS in range filters (real domain-tool path via dates.ts)', () => {
    const q = new ODataBuilder()
      .ge('CURDATE', '2026-05-01T00:00:00Z')
      .le('CURDATE', '2026-05-31T23:59:59Z')
      .build();
    expect(decodeURIComponent(q)).toBe(
      '?$filter=CURDATE ge 2026-05-01T00:00:00Z and CURDATE le 2026-05-31T23:59:59Z',
    );
  });

  it('joins multiple filters with and', () => {
    const q = new ODataBuilder().eq('STATDES', 'active').ge('CUSTBALANCE', 1000).build();
    expect(decodeURIComponent(q)).toBe("?$filter=STATDES eq 'active' and CUSTBALANCE ge 1000");
  });

  it('builds $select with literal commas and unchanged field names', () => {
    expect(new ODataBuilder().select('CUSTNAME', 'CUSTDES').build()).toBe(
      '?$select=CUSTNAME,CUSTDES',
    );
  });

  it('builds $expand', () => {
    expect(new ODataBuilder().expand('ORDERS_SUBFORM', 'CUSTPERSONNEL_SUBFORM').build()).toBe(
      '?$expand=ORDERS_SUBFORM,CUSTPERSONNEL_SUBFORM',
    );
  });

  it('encodes the space in $orderby direction', () => {
    expect(new ODataBuilder().orderBy('CUSTNAME', 'desc').build()).toBe(
      '?$orderby=CUSTNAME%20desc',
    );
  });

  it('builds a complex query in the fixed option order', () => {
    const q = new ODataBuilder()
      .eq('STATDES', 'active')
      .ge('CUSTBALANCE', 500)
      .select('CUSTNAME', 'CUSTDES', 'CUSTBALANCE')
      .expand('ORDERS_SUBFORM')
      .orderBy('CUSTBALANCE', 'desc')
      .top(25)
      .skip(0)
      .build();

    expect(q).toContain('$filter=');
    expect(q).toContain('$select=CUSTNAME,CUSTDES,CUSTBALANCE');
    expect(q).toContain('$expand=ORDERS_SUBFORM');
    expect(q).toContain('$orderby=CUSTBALANCE%20desc');
    expect(q).toContain('$top=25');
    expect(q).toContain('$skip=0');
    expect(decodeURIComponent(q)).toContain("$filter=STATDES eq 'active' and CUSTBALANCE ge 500");
  });

  it('orGroup wraps multiple conditions in parentheses as one AND-composable term', () => {
    const q = new ODataBuilder()
      .eq('STATDES', 'active')
      .orGroup("SUPNAME eq 'X'", "SUPDES eq 'X'")
      .build();
    expect(decodeURIComponent(q)).toBe(
      "?$filter=STATDES eq 'active' and (SUPNAME eq 'X' or SUPDES eq 'X')",
    );
  });

  it('orGroup with a single condition adds no parentheses', () => {
    expect(decodeURIComponent(new ODataBuilder().orGroup("CLOSED ne 'Y'").build())).toBe(
      "?$filter=CLOSED ne 'Y'",
    );
  });

  it('orGroup with no conditions is a no-op', () => {
    expect(new ODataBuilder().orGroup().build()).toBe('');
  });
});
