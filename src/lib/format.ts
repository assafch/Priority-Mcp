/**
 * Normalize Priority date formats to ISO 8601.
 * Priority sometimes returns /Date(...)/ legacy format.
 */
export function normalizeDate(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') {
    const match = value.match(/^\/Date\((\d+)\)\/$/);
    if (match) {
      return new Date(Number(match[1])).toISOString();
    }
    return value;
  }
  return null;
}

/** Format number as currency string */
export function formatCurrency(amount: number, currency = 'ILS'): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
}
