/**
 * Sanitize OData filter values to prevent injection.
 */
export function sanitizeODataValue(value: string): string {
  // Remove characters that could break OData queries
  return value.replace(/['";\\/]/g, '');
}

/** Ensure a field name is alphanumeric + underscore only */
export function sanitizeFieldName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '');
}
