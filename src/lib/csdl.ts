/**
 * Minimal parser for the CSDL (OData v4 metadata XML) that Priority's
 * GetMetadataFor(entity='X') returns. Extracts the requested form's fields (with their
 * Priority Hebrew/locale title and mandatory flag), key, and sub-forms (navigation
 * properties) into clean JSON. Regex-based (no XML dependency) and scoped to the regular
 * shape Priority emits; callers fall back to the raw XML if parsing yields nothing.
 */

function decodeEntities(s: string | undefined): string | undefined {
  if (s === undefined) return undefined;
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number.parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface CsdlField {
  name: string;
  type: string;
  maxLength?: number;
  title?: string;
  mandatory: boolean;
}

export interface CsdlEntity {
  entity: string;
  title?: string;
  key: string[];
  fieldCount: number;
  fields: CsdlField[];
  subforms: string[];
}

/** Parse the CSDL for one entity. Returns null if the entity block can't be found. */
export function parseCsdlEntity(xml: string, entity: string): CsdlEntity | null {
  const block = xml.match(
    new RegExp(`<EntityType Name="${escapeRegExp(entity)}"[\\s\\S]*?</EntityType>`),
  );
  if (!block) return null;
  const b = block[0];

  // Entity-level title: the first Description annotation before any <Property>.
  const head = b.slice(0, b.indexOf('<Property') === -1 ? b.length : b.indexOf('<Property'));
  const entityTitle = decodeEntities(
    head.match(/Priority\.OData\.Description"\s+String="([^"]*)"/)?.[1],
  );

  const key = [...b.matchAll(/<PropertyRef Name="([^"]+)"/g)].map((m) => m[1]);

  const fields: CsdlField[] = [];
  const propRe = /<Property\s+([^>]*?)(\/>|>([\s\S]*?)<\/Property>)/g;
  for (const m of b.matchAll(propRe)) {
    const attrs = m[1];
    const inner = m[3] ?? '';
    const name = attrs.match(/Name="([^"]+)"/)?.[1];
    const type = attrs.match(/Type="([^"]+)"/)?.[1];
    if (!name || !type) continue;
    const maxLength = attrs.match(/MaxLength="(\d+)"/)?.[1];
    fields.push({
      name,
      type,
      maxLength: maxLength ? Number(maxLength) : undefined,
      title: decodeEntities(inner.match(/Priority\.OData\.Description"\s+String="([^"]*)"/)?.[1]),
      mandatory: /Priority\.OData\.Mandatory"\s+Bool="true"/.test(inner),
    });
  }

  const subforms = [...b.matchAll(/<NavigationProperty Name="([^"]+)"/g)].map((m) => m[1]);

  return { entity, title: entityTitle, key, fieldCount: fields.length, fields, subforms };
}
