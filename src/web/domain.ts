import { createHash } from 'node:crypto';
import { z } from 'zod';

// Business intent only. These are NOT Priority form names, field names or record IDs.
export const customers = { 'demo-customer': 'לקוח הדגמה בע״מ', 'demo-customer-2': 'חנות לדוגמה' };
export const suppliers = { 'demo-supplier': 'ספק הדגמה בע״מ' };
export const products = { 'demo-product': 'מוצר לדוגמה', 'demo-service': 'שירות לדוגמה' };
export const payments = { transfer: 'העברה בנקאית', cash: 'מזומן', card: 'כרטיס אשראי' };
export const kinds = {
  invoice_receipt: 'חשבונית מס־קבלה',
  supplier: 'ספק חדש',
  purchase_order: 'הזמנת רכש',
};
export type RequestKind = keyof typeof kinds;
export class WebError extends Error {
  constructor(
    public readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 503,
    message: string,
  ) {
    super(message);
  }
}

const shortText = z.string().trim().min(1).max(120);
const supplierFields = {
  supplierName: shortText,
  registrationNumber: z.string().regex(/^\d{9}$/),
  contactName: shortText,
  email: z.string().trim().email().max(160),
};
const lineFields = {
  product: z.enum(['demo-product', 'demo-service']),
  quantity: z
    .string()
    .regex(/^[1-9]\d{0,3}$/)
    .transform(Number)
    .pipe(z.number().max(1000)),
  unitPrice: z
    .string()
    .regex(/^\d{1,6}(\.\d{1,2})?$/)
    .transform((s) => {
      const [whole, fraction = ''] = s.split('.');
      return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
    })
    .pipe(z.number().int().positive().max(10_000_000)),
};
const baseFields = {
  reference: z
    .string()
    .trim()
    .min(3)
    .max(80)
    .regex(/^[\p{L}\p{N} _./-]+$/u),
  notes: z.string().trim().max(500).default(''),
};
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  });
const invoice = z
  .object({
    kind: z.literal('invoice_receipt'),
    ...baseFields,
    ...lineFields,
    customer: z.enum(['demo-customer', 'demo-customer-2']),
    date,
    payment: z.enum(['transfer', 'cash', 'card']),
    paymentReference: shortText,
  })
  .strict();
const supplier = z
  .object({ kind: z.literal('supplier'), ...baseFields, ...supplierFields })
  .strict();
const purchaseOrder = z
  .object({
    kind: z.literal('purchase_order'),
    ...baseFields,
    ...lineFields,
    date,
    supplier: z.enum(['demo-supplier', 'new']),
    supplierName: z.string().max(120).default(''),
    registrationNumber: z.string().max(9).default(''),
    contactName: z.string().max(120).default(''),
    email: z.string().max(160).default(''),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.supplier === 'new') {
      const checked = z.object(supplierFields).safeParse(value);
      if (!checked.success) for (const issue of checked.error.issues) ctx.addIssue(issue);
    } else if (
      [value.supplierName, value.registrationNumber, value.contactName, value.email].some(Boolean)
    ) {
      ctx.addIssue({ code: 'custom', message: 'בחרו ספק חדש כדי להזין פרטי ספק.' });
    }
  });
export const submissionSchema = z.union([invoice, supplier, purchaseOrder]);
export type Submission = z.infer<typeof submissionSchema>;
export const submissionKeySchema = z.string().uuid();

export function parseSubmission(input: unknown): Submission {
  const parsed = submissionSchema.safeParse(input);
  if (!parsed.success)
    throw new WebError(
      400,
      'יש לבדוק את השדות: שדות חובה, תאריך תקין, כמות 1–1000 ומחיר חיובי עם עד שתי ספרות אחרי הנקודה. פרטי ספק חדש נדרשים רק בבחירה בספק חדש.',
    );
  return parsed.data;
}

export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
    .join(',')}}`;
}
export function contentHash(actorId: string, version: number, payload: Submission): string {
  return digest(canonical({ actorId, version, target: 'demo-only', payload }));
}

export const demoResult = {
  mode: 'demo',
  status: 'saved_locally',
  priorityVerified: false,
  message: 'הבקשה נשמרה באתר בלבד. לא נוצרו רשומות ב־Priority.',
  approval: 'האישור החיצוני אינו מחובר בגרסה זו. הבקשה לא נשלחה לאישור.',
  createdRecords: [],
} as const;

export interface SavedRequest {
  id: string;
  actorId: string;
  version: number;
  contentHash: string;
  payload: Submission;
  createdAt: number;
  result: typeof demoResult;
}
