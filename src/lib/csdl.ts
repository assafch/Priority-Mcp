/**
 * Minimal parser for the CSDL (OData v4 metadata) that Priority returns.
 *
 * TWO REPRESENTATIONS, same endpoint. `GetMetadataFor(entity='X')` and `$metadata` normally
 * answer CSDL **XML**, but `$metadata` intermittently answers CSDL **JSON**
 * (`content-type: application/json; odata.metadata=minimal`) for the very same request —
 * observed live on 2026-07-29, alternating between consecutive calls. Code that assumed XML
 * silently produced "0 entity types" (the client JSON-parses a json content-type, so the
 * string regex found nothing). Everything here therefore accepts EITHER shape.
 *
 * XML parsing is regex-based (no XML dependency) and scoped to the regular shape Priority
 * emits; callers fall back to the raw payload if parsing yields nothing.
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

// ─────────────────────────────────────────────────────────────── CSDL JSON shape
// { "$Version": "4.0", "$EntityContainer": "...", "Priority.OData": {
//     "ABILITIES": { "$Kind": "EntityType", "$Key": ["ABILITYCODE"],
//                    "ABILITYCODE": { "$Nullable": true, "$MaxLength": 3,
//                                     "@Priority.OData.Description": "קוד כישור",
//                                     "@Priority.OData.Mandatory": true },
//                    "SOME_SUBFORM": { "$Kind": "NavigationProperty", "$Collection": true, … } } } }
// A member with no "$Kind" is a Property; a property with no "$Type" is Edm.String.

type JsonObject = Record<string, unknown>;

function isJsonObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The schema namespace object of a CSDL-JSON document (e.g. "Priority.OData"), or null. */
function csdlJsonNamespace(doc: unknown): JsonObject | null {
  if (!isJsonObject(doc) || doc.$Version === undefined) return null;
  for (const [key, value] of Object.entries(doc)) {
    if (key.startsWith('$')) continue;
    if (isJsonObject(value)) return value;
  }
  return null;
}

/** Every entity-type name in a CSDL document, XML or JSON. Null when it isn't CSDL at all. */
export function csdlEntityNames(metadata: unknown): string[] | null {
  if (typeof metadata === 'string') {
    if (!metadata.includes('<EntityType')) return null;
    return [...new Set([...metadata.matchAll(/EntityType Name="([^"]+)"/g)].map((m) => m[1]))];
  }
  const ns = csdlJsonNamespace(metadata);
  if (!ns) return null;
  return Object.entries(ns)
    .filter(([name, v]) => !name.startsWith('$') && isJsonObject(v) && v.$Kind === 'EntityType')
    .map(([name]) => name);
}

/** Parse one entity out of a CSDL-JSON document. */
function parseCsdlJsonEntity(doc: unknown, entity: string): CsdlEntity | null {
  const ns = csdlJsonNamespace(doc);
  const type = ns?.[entity];
  if (!isJsonObject(type) || type.$Kind !== 'EntityType') return null;

  const fields: CsdlField[] = [];
  const subforms: string[] = [];
  for (const [name, raw] of Object.entries(type)) {
    if (name.startsWith('$') || name.startsWith('@')) continue;
    if (!isJsonObject(raw)) continue;
    if (raw.$Kind === 'NavigationProperty') {
      subforms.push(name);
      continue;
    }
    if (raw.$Kind !== undefined) continue; // other member kinds (actions, terms…)
    const base = typeof raw.$Type === 'string' ? raw.$Type : 'Edm.String'; // CSDL default
    fields.push({
      name,
      type: raw.$Collection ? `Collection(${base})` : base,
      maxLength: typeof raw.$MaxLength === 'number' ? raw.$MaxLength : undefined,
      title:
        typeof raw['@Priority.OData.Description'] === 'string'
          ? raw['@Priority.OData.Description']
          : undefined,
      mandatory: raw['@Priority.OData.Mandatory'] === true,
    });
  }
  return {
    entity,
    title:
      typeof type['@Priority.OData.Description'] === 'string'
        ? type['@Priority.OData.Description']
        : undefined,
    key: Array.isArray(type.$Key) ? type.$Key.map(String) : [],
    fieldCount: fields.length,
    fields,
    subforms,
  };
}

/**
 * Parse one entity out of a CSDL document in EITHER representation. Prefer this over
 * parseCsdlEntity when the payload's shape is not guaranteed (i.e. anything from $metadata).
 */
export function parseCsdl(metadata: unknown, entity: string): CsdlEntity | null {
  if (typeof metadata === 'string') return parseCsdlEntity(metadata, entity);
  return parseCsdlJsonEntity(metadata, entity);
}

/** Parse the CSDL XML for one entity. Returns null if the entity block can't be found. */
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
