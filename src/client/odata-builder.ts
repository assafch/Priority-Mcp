/**
 * Type-safe OData query builder for Priority ERP.
 */
export class ODataBuilder {
  private filters: string[] = [];
  private selects: string[] = [];
  private expands: string[] = [];
  private orderBys: string[] = [];
  private topValue?: number;
  private skipValue?: number;

  filter(expr: string): this {
    if (expr) this.filters.push(expr);
    return this;
  }

  /** Convenience: field eq 'value' with proper quoting */
  eq(field: string, value: string | number): this {
    const v = typeof value === 'string' ? `'${value.replace(/'/g, "''")}'` : String(value);
    return this.filter(`${field} eq ${v}`);
  }

  gt(field: string, value: string | number): this {
    const v = typeof value === 'string' ? `'${value.replace(/'/g, "''")}'` : String(value);
    return this.filter(`${field} gt ${v}`);
  }

  lt(field: string, value: string | number): this {
    const v = typeof value === 'string' ? `'${value.replace(/'/g, "''")}'` : String(value);
    return this.filter(`${field} lt ${v}`);
  }

  ge(field: string, value: string | number): this {
    const v = typeof value === 'string' ? `'${value.replace(/'/g, "''")}'` : String(value);
    return this.filter(`${field} ge ${v}`);
  }

  le(field: string, value: string | number): this {
    const v = typeof value === 'string' ? `'${value.replace(/'/g, "''")}'` : String(value);
    return this.filter(`${field} le ${v}`);
  }

  contains(field: string, value: string): this {
    return this.filter(`contains(${field},'${value.replace(/'/g, "''")}')`);
  }

  startsWith(field: string, value: string): this {
    return this.filter(`startswith(${field},'${value.replace(/'/g, "''")}')`);
  }

  select(...fields: string[]): this {
    this.selects.push(...fields);
    return this;
  }

  expand(...subforms: string[]): this {
    this.expands.push(...subforms);
    return this;
  }

  orderBy(field: string, direction: 'asc' | 'desc' = 'asc'): this {
    this.orderBys.push(`${field} ${direction}`);
    return this;
  }

  top(n: number): this {
    this.topValue = n;
    return this;
  }

  skip(n: number): this {
    this.skipValue = n;
    return this;
  }

  build(): string {
    const params: string[] = [];
    if (this.filters.length) params.push(`$filter=${this.filters.join(' and ')}`);
    if (this.selects.length) params.push(`$select=${this.selects.join(',')}`);
    if (this.expands.length) params.push(`$expand=${this.expands.join(',')}`);
    if (this.orderBys.length) params.push(`$orderby=${this.orderBys.join(',')}`);
    if (this.topValue !== undefined) params.push(`$top=${this.topValue}`);
    if (this.skipValue !== undefined) params.push(`$skip=${this.skipValue}`);
    return params.length ? `?${params.join('&')}` : '';
  }
}
