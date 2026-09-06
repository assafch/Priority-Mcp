import { describe, expect, it } from 'vitest';
import { csdlEntityNames, parseCsdl } from '../src/lib/csdl.js';

/**
 * Priority answers $metadata with CSDL XML on some calls and CSDL JSON on others — the same
 * request, alternating between consecutive calls (verified live 2026-07-29: 10,021,963 chars of
 * `application/xml` then 7,358,152 chars of `application/json; odata.metadata=minimal`).
 * The JSON shape below is copied from that response.
 */
const JSON_CSDL = {
  $Version: '4.0',
  $EntityContainer: 'Priority.OData.Container',
  'Priority.OData': {
    ABILITIES: {
      $Kind: 'EntityType',
      $Key: ['ABILITYCODE'],
      '@Priority.OData.Description': 'כישורים',
      ABILITYCODE: {
        $Nullable: true,
        $MaxLength: 3,
        '@Priority.OData.Description': 'קוד כישור',
        '@Priority.OData.Mandatory': true,
      },
      ABILITY: { $Type: 'Edm.Int64', $Nullable: true },
      EXTFILES_SUBFORM: {
        $Kind: 'NavigationProperty',
        $Collection: true,
        $Type: 'Priority.OData.EXTFILES',
      },
    },
    IMPFILES: { $Kind: 'EntityType', $Key: ['IMPFNUM'], IMPFNUM: { $MaxLength: 16 } },
    SomeTerm: { $Kind: 'Term', $Type: 'Edm.String' },
    Container: { $Kind: 'EntityContainer' },
  },
};

const XML_CSDL = `<?xml version="1.0"?><edmx:Edmx><Schema Namespace="Priority.OData">
<EntityType Name="ABILITIES"><Key><PropertyRef Name="ABILITYCODE" /></Key>
<Property Name="ABILITYCODE" Type="Edm.String" MaxLength="3"><Annotation Term="Priority.OData.Description" String="קוד כישור" /><Annotation Term="Priority.OData.Mandatory" Bool="true" /></Property>
<Property Name="ABILITY" Type="Edm.Int64" />
<NavigationProperty Name="EXTFILES_SUBFORM" Type="Collection(Priority.OData.EXTFILES)" />
</EntityType>
<EntityType Name="IMPFILES"><Key><PropertyRef Name="IMPFNUM" /></Key><Property Name="IMPFNUM" Type="Edm.String" MaxLength="16" /></EntityType>
</Schema></edmx:Edmx>`;

describe('csdlEntityNames', () => {
  it('reads entity types out of CSDL XML', () => {
    expect(csdlEntityNames(XML_CSDL)).toEqual(['ABILITIES', 'IMPFILES']);
  });

  it('reads entity types out of CSDL JSON, ignoring terms and the container', () => {
    expect(csdlEntityNames(JSON_CSDL)).toEqual(['ABILITIES', 'IMPFILES']);
  });

  it('returns null for something that is not CSDL (so callers can fail loudly)', () => {
    expect(csdlEntityNames('<html>gateway error</html>')).toBeNull();
    expect(csdlEntityNames('')).toBeNull();
    expect(csdlEntityNames(undefined)).toBeNull(); // the empty-200 case
    expect(csdlEntityNames({ value: [] })).toBeNull(); // an ordinary OData payload
  });
});

describe('parseCsdl', () => {
  it('parses an entity identically from either representation', () => {
    const fromXml = parseCsdl(XML_CSDL, 'ABILITIES');
    const fromJson = parseCsdl(JSON_CSDL, 'ABILITIES');
    for (const parsed of [fromXml, fromJson]) {
      expect(parsed?.key).toEqual(['ABILITYCODE']);
      expect(parsed?.subforms).toEqual(['EXTFILES_SUBFORM']);
      expect(parsed?.fields.map((f) => f.name)).toEqual(['ABILITYCODE', 'ABILITY']);
      const code = parsed?.fields.find((f) => f.name === 'ABILITYCODE');
      expect(code?.type).toBe('Edm.String'); // CSDL default when $Type is absent
      expect(code?.maxLength).toBe(3);
      expect(code?.mandatory).toBe(true);
      expect(code?.title).toBe('קוד כישור');
      expect(parsed?.fields.find((f) => f.name === 'ABILITY')?.type).toBe('Edm.Int64');
    }
  });

  it('keeps the entity title from JSON annotations', () => {
    expect(parseCsdl(JSON_CSDL, 'ABILITIES')?.title).toBe('כישורים');
  });

  it('returns null for an entity that is not in the document', () => {
    expect(parseCsdl(JSON_CSDL, 'NOPE')).toBeNull();
    expect(parseCsdl(XML_CSDL, 'NOPE')).toBeNull();
  });

  it('returns null for a non-CSDL payload instead of throwing', () => {
    expect(parseCsdl(undefined, 'ABILITIES')).toBeNull();
    expect(parseCsdl({ value: [] }, 'ABILITIES')).toBeNull();
  });
});
