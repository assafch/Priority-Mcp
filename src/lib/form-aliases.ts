/**
 * Names that LOOK like Priority forms but are not entity sets on this OData service, mapped to
 * what to use instead.
 *
 * Why this exists: an absent entity set answers HTTP 404 with an EMPTY body, so the error alone
 * ("Not found:") gives the caller nothing to act on. Every entry below was hit for real against
 * company a051014 (tabp008h.ini) and re-verified live on 2026-07-29. This map is deliberately
 * STATIC and client-free so the error path can consult it without an extra round-trip — resolving
 * a 404 must never cost another request (the service document takes ~65s to fetch here).
 *
 * Three shapes of wrong name are covered:
 *   1. wrong name for a real form   (GLPERIODS → ACCDATES)
 *   2. a sub-form mistaken for a table (IMPFILEITEMS → IMPFILES/IMPFILEITEMS_SUBFORM)
 *   3. a form that does not exist here at all, where a different form answers the question
 *      (BANKACCOUNTS → ACCOUNTS filtered to cash/bank accounts)
 */

export interface FormAlias {
  /** The form/path to use instead. */
  use: string;
  /** One line on why, in the caller's terms. */
  note: string;
}

export const FORM_ALIASES: Record<string, FormAlias> = {
  // --- wrong name for a real form -------------------------------------------------
  GLPERIODS: {
    use: 'ACCDATES',
    note: 'accounting period / date control is ACCDATES on this install (verified readable)',
  },
  LOGCOUNTERS: {
    use: 'LASTCOUNT',
    note: 'last stock-count per part/warehouse is LASTCOUNT (verified readable)',
  },
  WARHSBAL: {
    use: 'WARHSBALREP',
    note: 'warehouse balance report is WARHSBALREP (verified readable)',
  },
  COSTINGLOGCOUNTS: {
    use: 'COSTINGLOG',
    note: 'costing (תמחיר) run log is COSTINGLOG (verified readable)',
  },
  // --- a sub-form mistaken for a top-level table ----------------------------------
  IMPFILEITEMS: {
    use: "IMPFILES('<IMPFNUM>')/IMPFILEITEMS_SUBFORM",
    note: 'import-file goods content is a SUB-FORM of IMPFILES, not a table — use impfile_get, or priority_query with expand=["IMPFILEITEMS_SUBFORM"]',
  },
  TRANSIMPFILE: {
    use: 'IMPFILEIV (invoice ↔ file links) or IMPFILES sub-forms via impfile_get',
    note: "there is no import-file transactions table here; the file's invoices are IMPFILEIV / IMPFILES→IMPFILEINV_SUBFORM",
  },
  EXTFILES: {
    use: "<FORM>('<key>')/EXTFILES_SUBFORM",
    note: 'attachments are a sub-form of their parent document, not a global table — use priority_list_attachments / priority_upload_attachment',
  },
  PARTBALANCE: {
    use: "LOGPART('<PARTNAME>')/PARTBALANCE_SUBFORM",
    note: 'per-part on-hand is a LOGPART sub-form — use priority_get_stock_levels',
  },
  LOCWARHSBAL: {
    use: "LOGPART('<PARTNAME>')/PARTBALANCE_SUBFORM (PARTBAL exists but its API flag is off)",
    note: 'per-location balances come from the LOGPART sub-form here',
  },
  // --- form does not exist; a different one answers the question -------------------
  BANKACCOUNTS: {
    use: "ACCOUNTS with $filter=CASHNAME ne '' (bank/cash GL accounts)",
    note: 'no bank-account master is exposed; balances live on the GL accounts flagged for cash flow — use priority_get_bank_balances',
  },
  CASHACC: {
    use: "ACCOUNTS with $filter=CASHNAME ne '' (bank/cash GL accounts)",
    note: 'no CASHACC entity here; BANKS/CASH exist but their API flag is off — use priority_get_bank_balances',
  },
  AGED_BALANCES: {
    use: 'OPENINVOICES / OBLIGO',
    note: 'no aged-balance form is exposed — use priority_get_open_debts or priority_get_customer_balance',
  },
  SUP_AGED_BALANCES: {
    use: 'ACCOUNTS_PAYABLE',
    note: 'no supplier aged-balance form is exposed; the GL A/P form is readable',
  },
  OPENDEBT: {
    use: 'OPENINVOICES',
    note: 'open A/R items are OPENINVOICES here (no PAYDATE on it)',
  },
  SUP_OPENDEBT: {
    use: 'ACCOUNTS_PAYABLE',
    note: 'no supplier open-item form is exposed; the GL A/P form is readable',
  },
};

/**
 * Forms that DO exist as entity sets but whose "Available for API" flag is off, i.e. they answer
 * 400 "לא ניתן להפעיל API למסך זה" rather than 404. Naming them lets a tool tell an admin exactly
 * which screen to tick instead of leaving the caller to guess. Verified live 2026-07-29.
 */
export const API_FLAG_OFF: Record<string, string> = {
  COMPANIES: 'company list (priority_list_companies)',
  PIVDETAILS: 'supplier-invoice detail update — "עדכון פרטים לחשבוניות ספק"',
  BANKS: 'bank directory',
  BANKPAGES: 'bank pages / statements',
  BANKLINESA: 'bank statement lines (A)',
  BANKLINESB: 'bank statement lines (B)',
  BANKRECON: 'bank reconciliation',
  BANKRECONQ: 'bank reconciliation query',
  CASH: 'deposit centers (מרכזי הפקדה)',
  CASH_BANKS: 'deposit centers — banks',
  PARTBAL: 'stock balance by warehouse',
  VATTYPES: 'VAT types',
  TODOLIST: 'tasks / to-do list',
  GENDIARY: 'CRM diary / activities',
  SALESINVOICEITEMS: 'sales invoice line items',
};

/** Alias guidance for a name, or undefined when the name isn't a known mistake. */
export function aliasHint(form: string | undefined): string | undefined {
  if (!form) return undefined;
  const alias = FORM_ALIASES[form.toUpperCase()];
  if (alias) return `Use ${alias.use} instead — ${alias.note}.`;
  const flagged = API_FLAG_OFF[form.toUpperCase()];
  if (flagged)
    return `'${form}' (${flagged}) DOES exist on this installation but its "Available for API" flag is off — a Priority admin must tick it in the API/Limited-Access Forms screen.`;
  return undefined;
}
