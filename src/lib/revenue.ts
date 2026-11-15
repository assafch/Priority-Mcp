/**
 * Revenue aggregation over AINVOICES header rows.
 *
 * Two correctness rules this module encodes (both were audit findings on the finance tools):
 *
 *  1. REVENUE IS NET (pre-VAT). On this install TOTPRICE is the VAT-INCLUSIVE payable total
 *     ('סה"כ לתשלום'); VAT is the tax portion. So net revenue = TOTPRICE − VAT. Summing
 *     TOTPRICE and calling it "revenue" overstates by the VAT (~18%) and won't reconcile with
 *     the P&L. Callers get net as the headline figure plus the VAT-inclusive gross alongside.
 *
 *  2. ONLY FINAL INVOICES COUNT. AINVOICES also holds un-posted DRAFTS ('טיוטא', carrying
 *     temporary 'T'-prefixed numbers) and CANCELLED invoices ('מבוטלת'). Neither is revenue.
 *     Restricting the query to STATDES = FINAL_INVOICE_STATUS excludes both server-side.
 *     Credit memos are final AINVOICES with negative amounts and net down correctly.
 */

/** STATDES of a FINAL (posted) tax invoice on this install — excludes drafts and cancelled. */
export const FINAL_INVOICE_STATUS = 'סופית';

export interface RevenueTotals {
  /** Pre-VAT revenue: sum of (TOTPRICE − VAT). */
  netRevenue: number;
  /** Sum of VAT. */
  vat: number;
  /** VAT-inclusive payable total: sum of TOTPRICE. */
  grossWithVat: number;
  /** Number of invoices summed. */
  count: number;
}

type InvoiceRow = Record<string, unknown>;

const grossOf = (row: InvoiceRow): number => Number(row.TOTPRICE) || 0;
const vatOf = (row: InvoiceRow): number => Number(row.VAT) || 0;

/** Sum net / VAT / gross across AINVOICES header rows. */
export function sumInvoiceRevenue(rows: InvoiceRow[]): RevenueTotals {
  let gross = 0;
  let vat = 0;
  for (const r of rows) {
    gross += grossOf(r);
    vat += vatOf(r);
  }
  return { netRevenue: gross - vat, vat, grossWithVat: gross, count: rows.length };
}

export interface CustomerRevenue {
  custName: string;
  netRevenue: number;
  grossWithVat: number;
  invoiceCount: number;
}

/** Aggregate rows by CUSTNAME and return the top N customers ranked by net revenue. */
export function rankCustomersByRevenue(rows: InvoiceRow[], topN: number): CustomerRevenue[] {
  const byCustomer = new Map<string, CustomerRevenue>();
  for (const r of rows) {
    const custName = String(r.CUSTNAME ?? '');
    const entry =
      byCustomer.get(custName) ??
      ({ custName, netRevenue: 0, grossWithVat: 0, invoiceCount: 0 } satisfies CustomerRevenue);
    const gross = grossOf(r);
    entry.netRevenue += gross - vatOf(r);
    entry.grossWithVat += gross;
    entry.invoiceCount += 1;
    byCustomer.set(custName, entry);
  }
  return [...byCustomer.values()].sort((a, b) => b.netRevenue - a.netRevenue).slice(0, topN);
}

export interface MonthRevenue extends RevenueTotals {
  /** Calendar month, 'YYYY-MM'. */
  period: string;
}

/** Group rows into calendar months (by IVDATE) with per-month net/VAT/gross totals, sorted. */
export function groupRevenueByMonth(rows: InvoiceRow[]): MonthRevenue[] {
  const byMonth = new Map<string, InvoiceRow[]>();
  for (const r of rows) {
    const period = String(r.IVDATE ?? '').slice(0, 7); // 'YYYY-MM'
    if (!/^\d{4}-\d{2}$/.test(period)) continue; // skip rows with no usable date
    const bucket = byMonth.get(period) ?? [];
    bucket.push(r);
    byMonth.set(period, bucket);
  }
  return [...byMonth.keys()]
    .sort()
    .map((period) => ({ period, ...sumInvoiceRevenue(byMonth.get(period) ?? []) }));
}
