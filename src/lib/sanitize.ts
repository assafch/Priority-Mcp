/**
 * Value helpers for OData filters.
 *
 * NOTE: correctness of OData values is handled by `odataLiteral`/`ODataBuilder`
 * (single-quote doubling) plus percent-encoding in `ODataBuilder.build()`. We therefore
 * do NOT strip meaningful characters here — doing so silently corrupted legitimate data
 * (e.g. "O'Brien" -> "OBrien", a part number "ABC/123" -> "ABC123", Hebrew with
 * punctuation). sanitizeODataValue now only removes ASCII control characters that can
 * never legitimately appear in a Priority field value.
 */
export function sanitizeODataValue(value: string): string {
  let out = '';
  for (const ch of String(value)) {
    const code = ch.codePointAt(0) ?? 0;
    // Drop C0 control chars (0-31) and DEL (127); keep everything else, incl. Hebrew.
    if (code >= 32 && code !== 127) out += ch;
  }
  return out;
}

/**
 * Escape a string for use INSIDE a single-quoted OData literal that you are building by
 * hand (i.e. not via ODataBuilder.eq/contains, which already escape). Doubles embedded
 * single quotes per the OData spec: O'Brien -> O''Brien.
 */
export function escapeODataString(value: string): string {
  return sanitizeODataValue(value).replace(/'/g, "''");
}

/** Ensure a field name is alphanumeric + underscore only (defends $select/$orderby inputs). */
export function sanitizeFieldName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_]/g, '');
}
