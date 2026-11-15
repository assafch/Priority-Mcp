/** Synthetic schema shape mirrors Priority: top-level metadata plus navigation entity types. */
export function reportMetadata(path: string): string {
  const form = path.match(/entity='([^']+)'/)?.[1];
  const keys: Record<string, string[]> = {
    AINVOICES: ['IVNUM', 'DEBIT', 'IVTYPE'],
    DOCUMENTS_D: ['DOCNO'],
    AINVOICEITEMS: ['LINEKEY'],
    TRANSORDER_D: ['LINEKEY'],
  };
  const nav: Record<string, [string, string]> = {
    AINVOICES: ['AINVOICEITEMS_SUBFORM', 'AINVOICEITEMS'],
    DOCUMENTS_D: ['TRANSORDER_D_SUBFORM', 'TRANSORDER_D'],
  };
  const entity = (name: string) =>
    `<EntityType Name="${name}"><Key>${(keys[name] ?? []).map((key) => `<PropertyRef Name="${key}"/>`).join('')}</Key>${[...(keys[name] ?? []), 'PARTNAME'].map((key) => `<Property Name="${key}" Type="Edm.String"/>`).join('')}${nav[name] ? `<NavigationProperty Name="${nav[name][0]}" Type="Collection(Priority.OData.${nav[name][1]})"/>` : ''}</EntityType>`;
  if (path === '$metadata') return `<Schema>${Object.keys(keys).map(entity).join('')}</Schema>`;
  if (!form || !nav[form]) throw new Error('Targeted metadata supports top-level forms only');
  return `<Schema>${entity(form)}</Schema>`;
}
