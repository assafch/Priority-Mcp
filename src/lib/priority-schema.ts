/**
 * Verified per-form schema facts for THIS Priority installation.
 *
 * Field/form names in Priority are installation-dependent. The names below were confirmed
 * live (company a051014, server p.priority-connect.online, tabp008h.ini) via
 * GetMetadataFor + bounded reads on 2026-06-01. They drive:
 *   - correct date fields for range filters / default sort (e.g. AINVOICES uses IVDATE, NOT CURDATE),
 *   - compact default $select projections so list tools don't return every column,
 *   - the fields a fuzzy search should match,
 *   - composite-key detection (a single-key .get() 404s on composite-keyed forms like AINVOICES).
 *
 * When a form is not in this map, callers fall back to their previous behavior (no projection,
 * no special date field). Keep this map conservative: only list fields verified to exist.
 */

export interface FormSchema {
  /** Key field name(s). length > 1 ⇒ composite key (cannot fetch via single-value .get()). */
  key: string[];
  /** Date field for range filters and default sort, if the form has one. */
  dateField?: string;
  /** Human-readable description/name field. */
  nameField?: string;
  /** Fields a fuzzy text search should match (all verified to exist). */
  searchFields?: string[];
  /** Compact projection list tools return by default (all verified to exist). */
  defaultSelect?: string[];
  /** Line-item navigation property to $expand for full detail. */
  lineSubform?: string;
}

export const FORM_SCHEMA: Record<string, FormSchema> = {
  CUSTOMERS: {
    key: ['CUSTNAME'],
    dateField: 'CREATEDDATE',
    nameField: 'CUSTDES',
    searchFields: ['CUSTDES', 'CUSTNAME', 'PHONE', 'EMAIL', 'WTAXNUM'],
    defaultSelect: ['CUSTNAME', 'CUSTDES', 'STATDES', 'PHONE', 'EMAIL', 'AGENTNAME'],
  },
  SUPPLIERS: {
    key: ['SUPNAME'],
    dateField: 'CREATEDDATE',
    nameField: 'SUPDES',
    searchFields: ['SUPDES', 'SUPNAME', 'PHONE', 'EMAIL'],
    defaultSelect: ['SUPNAME', 'SUPDES', 'STATDES', 'PHONE', 'EMAIL'],
  },
  LOGPART: {
    key: ['PARTNAME'],
    nameField: 'PARTDES',
    searchFields: ['PARTDES', 'PARTNAME', 'BARCODE'],
    defaultSelect: ['PARTNAME', 'PARTDES', 'FAMILYDES'],
  },
  AINVOICES: {
    // Composite key — single-value .get('IV123') 404s; query by $filter on IVNUM instead.
    key: ['IVNUM', 'DEBIT', 'IVTYPE'],
    dateField: 'IVDATE',
    nameField: 'CDES',
    defaultSelect: [
      'IVNUM',
      'IVDATE',
      'CUSTNAME',
      'CDES',
      'STATDES',
      'QPRICE',
      'VAT',
      'TOTPRICE',
      'CODE',
    ],
    lineSubform: 'AINVOICEITEMS_SUBFORM',
  },
  ORDERS: {
    key: ['ORDNAME'],
    dateField: 'CURDATE',
    nameField: 'CDES',
    defaultSelect: [
      'ORDNAME',
      'CURDATE',
      'CUSTNAME',
      'CDES',
      'ORDSTATUSDES',
      'QPRICE',
      'TOTPRICE',
      'CODE',
    ],
    lineSubform: 'ORDERITEMS_SUBFORM',
  },
  PORDERS: {
    key: ['ORDNAME'],
    dateField: 'CURDATE',
    nameField: 'CDES',
    defaultSelect: ['ORDNAME', 'CURDATE', 'SUPNAME', 'CDES', 'STATDES', 'TOTPRICE', 'CODE'],
    lineSubform: 'PORDERITEMS_SUBFORM',
  },
  // Customer balance/credit snapshot — CUSTOMERS itself has NO balance field on this install.
  // CREDIT = open A/R balance, MAX_CREDIT = limit, CREDIT_REST = available.
  OBLIGO: {
    key: ['CUSTNAME'],
    nameField: 'CUSTDES',
    defaultSelect: [
      'CUSTNAME',
      'CUSTDES',
      'CREDIT',
      'MAX_CREDIT',
      'CREDIT_REST',
      'OBLIGO',
      'MAX_OBLIGO',
      'AGENTNAME',
      'CODE',
    ],
  },
  // CAUTION: despite the name, on this install OPENINVOICES holds open DELIVERY NOTES /
  // RETURNS awaiting invoicing (DOCCODE "משלק"/"החלק"), NOT issued tax invoices. For a
  // customer's unpaid *invoices* use AINVOICES filtered on empty IVRECONDATE instead
  // (see priority_get_unpaid_invoices_for_customer). Amount is TOTPRICE, date is CURDATE.
  OPENINVOICES: {
    key: ['DOCNO'],
    dateField: 'CURDATE',
    nameField: 'CUSTDES',
    defaultSelect: [
      'DOCNO',
      'DOCCODE',
      'CURDATE',
      'CUSTNAME',
      'CUSTDES',
      'TOTPRICE',
      'VAT',
      'CODE',
    ],
  },
  // Sales invoice LINE items. CAUTION: API-BLOCKED on this install — a direct query returns
  // 400 "לא ניתן להפעיל API למסך זה". Kept for its field names, but tools must NOT query it
  // directly; get per-product sales via priority_product_sales_by_period (AINVOICEITEMS_SUBFORM
  // expand). The schema below is retained for reference only.
  SALESINVOICEITEMS: {
    dateField: 'IVDATE',
    key: ['IVNUM', 'KLINE'],
    nameField: 'PDES',
    defaultSelect: [
      'IVDATE',
      'IVNUM',
      'CUSTNAME',
      'CDES',
      'PARTNAME',
      'PDES',
      'TQUANT',
      'QPRICE',
      'DISPRICE',
      'CODE',
    ],
  },
  // Stock balance by warehouse. CAUTION: API-BLOCKED on this install (400 "לא ניתן להפעיל API
  // למסך זה"). Per-part on-hand is instead read via LOGPART/PARTBALANCE_SUBFORM (see
  // priority_get_stock_levels). Field names kept for reference. BALANCE = on-hand (display unit),
  // TBALANCE = base-unit balance. No reorder-point column.
  PARTBAL: {
    key: ['PART', 'WARHS'],
    nameField: 'PARTDES',
    defaultSelect: [
      'PARTNAME',
      'PARTDES',
      'WARHSNAME',
      'LOCNAME',
      'BALANCE',
      'TBALANCE',
      'UNITNAME',
    ],
  },
  // Import files (תיקי יבוא). Single-value key, .get() works. Live-verified 2026-07-18
  // (company a051014). WARHSNAME title is "מחסן ערובה" (bonded warehouse); CUSTOMSNUM is the
  // import declaration (recorded per-line/per-invoice here, so header is usually blank).
  IMPFILES: {
    key: ['IMPFNUM'],
    dateField: 'CURDATE',
    nameField: 'SUPDES',
    searchFields: ['IMPFNUM', 'SUPDES', 'CUSTOMSNUM', 'ORDNAME'],
    defaultSelect: [
      'IMPFNUM',
      'CURDATE',
      'SUPDES',
      'STATDES',
      'CLOSED',
      'ORDNAME',
      'CODE',
      'WARHSNAME',
      'CUSTOMSNUM',
    ],
    lineSubform: 'IMPFILEITEMS_SUBFORM',
  },
  // Supplier invoices (חשבוניות ספק מרכזות). COMPOSITE key → single-value .get() 404s; query by
  // $filter on IVNUM. IMPFNUM + OTYPE='P' link an invoice to an import file; STORNOFLAG = cancelled.
  PINVOICES: {
    key: ['IVNUM', 'DEBIT', 'IVTYPE'],
    dateField: 'IVDATE',
    nameField: 'SUPDES',
    defaultSelect: [
      'IVNUM',
      'IVDATE',
      'SUPNAME',
      'SUPDES',
      'STATDES',
      'DISPRICE',
      'VAT',
      'TOTPRICE',
      'CODE',
      'IMPFNUM',
      'OTYPE',
      'FINAL',
      'STORNOFLAG',
    ],
    lineSubform: 'PINVOICEITEMS_SUBFORM',
  },
  // Warehouses (מחסנים). COMPOSITE key (WARHSNAME, LOCNAME). TYPE D/F/W; BONDED='Y' = bonded (מחסן
  // ערובה); COSTFLAG='Y' = included in inventory value. Queryable live 2026-07-18 (was blocked before).
  WAREHOUSES: {
    key: ['WARHSNAME', 'LOCNAME'],
    nameField: 'WARHSDES',
    searchFields: ['WARHSNAME', 'WARHSDES'],
    defaultSelect: ['WARHSNAME', 'WARHSDES', 'LOCNAME', 'TYPE', 'BONDED', 'COSTFLAG'],
  },
  // Customs items master (פריטי מכס). Country-tiered duty columns: PERCENT (general), PERCENT1 (EU),
  // PERCENT2 (N.America); PURTAXPERCENT (מס קניה), PURTAXADD (% תוספות). See COUNTRIES.CUSTOMSTYPE.
  CUSTOMSITEMS: {
    key: ['CUSTOMSITEMNAME'],
    nameField: 'CUSTOMSITEMDES',
    searchFields: ['CUSTOMSITEMNAME', 'CUSTOMSITEMDES'],
    defaultSelect: [
      'CUSTOMSITEMNAME',
      'CUSTOMSITEMDES',
      'PERCENT',
      'PERCENT1',
      'PERCENT2',
      'PURTAXPERCENT',
      'PURTAXADD',
    ],
  },
};

export function getSchema(form: string): FormSchema | undefined {
  return FORM_SCHEMA[form];
}

/** The date field for range filters / default sort on a form, or undefined if unknown. */
export function getDateField(form: string): string | undefined {
  return FORM_SCHEMA[form]?.dateField;
}

/** True when the form has a composite key (a single-value key predicate would 404). */
export function isCompositeKey(form: string): boolean {
  return (FORM_SCHEMA[form]?.key.length ?? 1) > 1;
}
