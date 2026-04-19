import { describe, it, expect } from 'vitest';
import { ODataBuilder } from '../src/client/odata-builder.js';

describe('ODataBuilder', () => {
  it('builds empty query', () => {
    expect(new ODataBuilder().build()).toBe('');
  });

  it('builds $top and $skip', () => {
    const q = new ODataBuilder().top(10).skip(20).build();
    expect(q).toBe('?$top=10&$skip=20');
  });

  it('builds eq filter with string', () => {
    const q = new ODataBuilder().eq('STATDES', 'active').build();
    expect(q).toBe("?$filter=STATDES eq 'active'");
  });

  it('builds eq filter with number', () => {
    const q = new ODataBuilder().eq('CUSTBALANCE', 100).build();
    expect(q).toBe('?$filter=CUSTBALANCE eq 100');
  });

  it('escapes single quotes in values', () => {
    const q = new ODataBuilder().eq('CUSTDES', "O'Brien").build();
    expect(q).toBe("?$filter=CUSTDES eq 'O''Brien'");
  });

  it('builds contains filter', () => {
    const q = new ODataBuilder().contains('CUSTDES', 'acme').build();
    expect(q).toBe("?$filter=contains(CUSTDES,'acme')");
  });

  it('builds multiple filters with AND', () => {
    const q = new ODataBuilder().eq('STATDES', 'active').ge('CUSTBALANCE', 1000).build();
    expect(q).toBe("?$filter=STATDES eq 'active' and CUSTBALANCE ge 1000");
  });

  it('builds $select', () => {
    const q = new ODataBuilder().select('CUSTNAME', 'CUSTDES').build();
    expect(q).toBe('?$select=CUSTNAME,CUSTDES');
  });

  it('builds $expand', () => {
    const q = new ODataBuilder().expand('ORDERS_SUBFORM', 'CUSTPERSONNEL_SUBFORM').build();
    expect(q).toBe('?$expand=ORDERS_SUBFORM,CUSTPERSONNEL_SUBFORM');
  });

  it('builds $orderby', () => {
    const q = new ODataBuilder().orderBy('CUSTNAME', 'desc').build();
    expect(q).toBe('?$orderby=CUSTNAME desc');
  });

  it('builds complex query', () => {
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
    expect(q).toContain('$orderby=CUSTBALANCE desc');
    expect(q).toContain('$top=25');
    expect(q).toContain('$skip=0');
  });
});
