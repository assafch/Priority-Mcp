import { customers, kinds, payments, products, suppliers } from './domain.js';
import type { RequestKind, SavedRequest, Submission } from './domain.js';
import type { Session } from './store.js';

export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c,
  );
}
const brand =
  '<div class="brand"><span class="brand-mark" aria-hidden="true">פ</span>פורטל בקשות</div>';
function document(title: string, content: string) {
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · פורטל בקשות</title><link rel="stylesheet" href="/assets/app.css"></head><body><a class="skip" href="#main">דילוג לתוכן</a>${content}</body></html>`;
}
export function hidden(name: string, value: string) {
  return `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`;
}
export function layout(title: string, content: string, session: Session, active = '') {
  const links = [
    ['/', 'סקירה כללית'],
    ['/requests/new/invoice_receipt', 'חשבונית מס־קבלה'],
    ['/requests/new/supplier', 'ספק חדש'],
    ['/requests/new/purchase_order', 'הזמנת רכש'],
    ['/requests', 'הבקשות שלי'],
  ];
  return document(
    title,
    `<div class="shell"><aside><div>${brand}<div class="subbrand">סביבת עבודה לסוכן</div></div><nav aria-label="ניווט ראשי">${links.map(([url, label]) => `<a href="${url}" ${active === url ? 'aria-current="page"' : ''}>${label}</a>`).join('')}</nav><div class="aside-note"><span class="dot"></span>סביבת הדגמה מקומית<br>הבקשות נשמרות באתר בלבד.</div></aside><div class="workspace"><header><span class="badge demo">מצב דמה · ללא כתיבה ל־Priority</span><div class="account"><span>${escapeHtml(session.username)} · סוכן מוגבל</span><form method="post" action="/logout">${hidden('csrf', session.csrf)}<button class="logout" type="submit">יציאה</button></form></div></header><main id="main">${content}<footer>פורטל בקשות · נתוני הדגמה בלבד · מסמך נשמר באתר אינו מסמך ב־Priority</footer></main></div></div>`,
  );
}
export function login(csrf: string, error = '') {
  return document(
    'כניסה',
    `<div class="login-page"><section class="login-story">${brand}<div class="eyebrow">סביבת הדגמה · INSTINCT AI</div><h1>מכינים בקשות.<br>עוקבים במקום אחד.</h1><p>חשבוניות, ספקים והזמנות רכש — דרך טפסים ברורים בעברית.</p><ol><li>נכנסים עם חשבון הסוכן</li><li>ממלאים בקשה עם נתוני דמה</li><li>קוראים את התוצאה ברשימת הבקשות</li></ol></section><main class="login-main" id="main"><div class="login-box"><span class="badge demo">גישה מוגבלת לסוכן</span><h1>כניסה לפורטל</h1><p class="muted">הזינו את פרטי חשבון האתר השמורים בכספת.</p>${error ? `<div class="notice error" role="alert">${escapeHtml(error)}</div>` : ''}<form method="post" action="/login">${hidden('csrf', csrf)}<div class="field"><label for="username">שם משתמש</label><input id="username" name="username" autocomplete="username" required maxlength="64" dir="ltr" autofocus></div><div class="field"><label for="password">סיסמה</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="128" dir="ltr"></div><button type="submit" class="primary">כניסה לפורטל</button></form><p class="login-footer">זהו חשבון האתר בלבד. אין להזין כאן פרטי התחברות ל־Priority. פרטי החשבון מוגדרים מקומית באמצעות הוראות ההפעלה.</p></div></main></div>`,
  );
}
function requestTable(requests: SavedRequest[]) {
  if (!requests.length)
    return '<div class="empty"><strong>עדיין אין בקשות להצגה</strong>לאחר שליחת טופס, הבקשה והתוצאה שלה יופיעו כאן.</div>';
  return `<div class="table-wrap"><table><thead><tr><th scope="col">אסמכתה</th><th scope="col">סוג בקשה</th><th scope="col">נוצרה בתאריך</th><th scope="col">מצב</th><th scope="col">תוצאה</th></tr></thead><tbody>${requests.map((r) => `<tr><td class="wrap">${escapeHtml(r.payload.reference)}</td><td>${kinds[r.payload.kind]}</td><td>${new Date(r.createdAt).toLocaleDateString('he-IL', { timeZone: 'Asia/Jerusalem' })}</td><td><span class="badge">נשמרה באתר · דמה</span></td><td><a href="/requests/${r.id}" aria-label="צפייה בבקשה ${escapeHtml(r.payload.reference)}">צפייה בבקשה ←</a></td></tr>`).join('')}</tbody></table></div>`;
}
export function dashboard(requests: SavedRequest[], session: Session) {
  const cards: [RequestKind, string, string][] = [
    ['invoice_receipt', '▤', 'הכנת בקשה הכוללת לקוח, פריט ופרטי תשלום לדוגמה.'],
    ['supplier', '＋', 'הכנת פרטי ספק חדש לבדיקת תהליך קליטת הבקשה.'],
    ['purchase_order', '▦', 'הכנת הזמנה לספק לדוגמה, או בקשה משולבת לספק חדש ולהזמנה.'],
  ];
  return layout(
    'סקירה כללית',
    `<div class="eyebrow">סביבת העבודה שלכם</div><h1>כל בקשה מתחילה כאן</h1><p class="muted intro">בחרו את הבקשה שתרצו להכין. אפשר למלא טופס, לשמור אותו ולצפות בתוצאה — הכל בסביבת הדגמה.</p><div class="banner"><span aria-hidden="true">◉</span><span>מצב דמה פעיל. לא נוצרים ספקים או מסמכים ב־Priority, והבקשות אינן נשלחות לאישור.</span></div><div class="grid">${cards.map(([kind, icon, desc]) => `<article class="card"><div class="card-icon" aria-hidden="true">${icon}</div><h2>${kinds[kind]}</h2><p>${desc}</p><a href="/requests/new/${kind}">הכנת בקשה ←</a></article>`).join('')}</div><section class="panel"><div class="panel-heading"><h2>הבקשות האחרונות</h2><a href="/requests">לכל הבקשות</a></div>${requestTable(requests.slice(0, 5))}</section><div class="help-grid"><div class="step"><b>1</b><div><strong>מכינים בקשה</strong><p>ממלאים טופס עסקי עם נתוני דמה.</p></div></div><div class="step"><b>2</b><div><strong>שומרים באתר</strong><p>מתקבל מזהה קבוע לצורך מעקב.</p></div></div><div class="step"><b>3</b><div><strong>בודקים את התוצאה</strong><p>התוצאה מציינת במפורש מה נשמר.</p></div></div></div>`,
    session,
    '/',
  );
}

export type FormValues = Record<string, string>;
export function requestForm(
  kind: RequestKind,
  session: Session,
  key: string,
  values: FormValues = {},
  error = '',
) {
  const input = (name: string, label: string, type = 'text', required = true, extra = '') =>
    `<div class="field"><label for="${name}">${label}${required ? ' *' : ''}</label><input id="${name}" name="${name}" type="${type}" value="${escapeHtml(values[name] ?? '')}" ${required ? 'required' : ''} ${extra}></div>`;
  const select = (name: string, label: string, options: Record<string, string>) =>
    `<div class="field"><label for="${name}">${label} *</label><select id="${name}" name="${name}" required><option value="">בחרו אפשרות</option>${Object.entries(
      options,
    )
      .map(
        ([value, text]) =>
          `<option value="${value}" ${values[name] === value ? 'selected' : ''}>${text}</option>`,
      )
      .join('')}</select></div>`;
  const supplierInputs = (required: boolean) =>
    `${input('supplierName', 'שם הספק לדוגמה', 'text', required, 'maxlength="120"')}${input('registrationNumber', 'מספר עוסק לדוגמה (9 ספרות)', 'text', required, 'pattern="[0-9]{9}" maxlength="9" inputmode="numeric"')}${input('contactName', 'איש קשר לדוגמה', 'text', required, 'maxlength="120"')}${input('email', 'דוא״ל לדוגמה', 'email', required, 'maxlength="160" dir="ltr" placeholder="contact@example.test"')}`;
  const lines = `<fieldset><legend>פרטי הפריט לדוגמה</legend><div class="form-grid">${select('product', 'פריט', products)}${input('quantity', 'כמות', 'number', true, 'min="1" max="1000" step="1"')}${input('unitPrice', 'מחיר יחידה לדוגמה (₪)', 'number', true, 'min="0.01" max="100000" step="0.01"')}<p class="muted">הסכום משמש להדגמה בלבד. מסים וסכום מסמך סופי אינם מחושבים בגרסה זו.</p></div></fieldset>`;
  let specific = '';
  if (kind === 'invoice_receipt')
    specific = `<fieldset><legend>לקוח ותשלום</legend><div class="form-grid">${select('customer', 'לקוח לדוגמה', customers)}${input('date', 'תאריך', 'date')}${select('payment', 'אמצעי תשלום לדוגמה', payments)}${input('paymentReference', 'אסמכתת תשלום לדוגמה', 'text', true, 'maxlength="120"')}<small class="muted wide">אין להזין מספרי כרטיס, פרטי בנק או סודות. פרטי התשלום משמשים לתיאור הבקשה בלבד.</small></div></fieldset>${lines}`;
  if (kind === 'supplier')
    specific = `<fieldset><legend>פרטי הספק לדוגמה</legend><div class="form-grid">${supplierInputs(true)}</div></fieldset>`;
  if (kind === 'purchase_order')
    specific = `<fieldset><legend>ספק ותאריך הזמנה</legend><div class="form-grid">${select('supplier', 'ספק', { ...suppliers, new: 'ספק חדש + הזמנת רכש' })}${input('date', 'תאריך', 'date')}</div></fieldset><fieldset><legend>פרטי ספק חדש — רק אם נבחר ספק חדש</legend><p class="muted">בבחירה בספק חדש, יש למלא את כל ארבעת השדות. בבחירה בספק לדוגמה, השאירו אותם ריקים.</p><div class="form-grid">${supplierInputs(false)}</div></fieldset>${lines}`;
  return layout(
    `הכנת ${kinds[kind]}`,
    `<a class="back" href="/">→ חזרה לסקירה</a><div class="eyebrow">בקשה חדשה · נתוני דמה בלבד</div><h1>הכנת בקשה ל${kinds[kind]}</h1><p class="muted">שדות המסומנים בכוכבית הם חובה. הבקשה תישמר באתר בלבד.</p>${error ? `<div class="notice error" role="alert">${escapeHtml(error)}</div>` : ''}<form method="post" action="/requests" class="panel form-panel">${hidden('csrf', session.csrf)}${hidden('submissionKey', key)}${hidden('kind', kind)}<fieldset><legend>פרטי הבקשה</legend><div class="form-grid">${input('reference', 'אסמכתת בקשה ייחודית', 'text', true, 'minlength="3" maxlength="80" placeholder="למשל DEMO-2026-001"')}<p class="muted">שמרו את האסמכתה. אם השליחה נקטעה, חפשו אותה ב״הבקשות שלי״ לפני ניסיון נוסף. לשליחה חוזרת יש להשתמש באותה אסמכתה ובאותו תוכן.</p></div></fieldset>${specific}<div class="field"><label for="notes">הערות (רשות)</label><textarea id="notes" name="notes" maxlength="500">${escapeHtml(values.notes ?? '')}</textarea></div><label class="check"><input type="checkbox" name="demoAcknowledged" value="yes" required ${values.demoAcknowledged === 'yes' ? 'checked' : ''}><span>אני שולח/ת נתוני דמה בלבד. ברור לי שהשמירה אינה יוצרת מסמך או ספק ב־Priority.</span></label><div class="actions"><button type="submit" class="primary">שמירת בקשת דמה</button><a href="/requests">צפייה בבקשות קיימות</a></div></form>`,
    session,
    `/requests/new/${kind}`,
  );
}

export function requestList(
  requests: SavedRequest[],
  session: Session,
  reference: string,
  page: number,
  hasMore: boolean,
) {
  return layout(
    'הבקשות שלי',
    `<div class="eyebrow">מעקב ותוצאות</div><h1>הבקשות שלי</h1><p class="muted">כל הבקשות כאן נשמרו באתר בלבד. במקרה של ניתוק או timeout, חפשו את האסמכתה לפני שליחה נוספת.</p><form method="get" action="/requests" class="search"><label class="field" for="reference">אסמכתה מדויקת<input id="reference" name="reference" value="${escapeHtml(reference)}" maxlength="80" placeholder="חיפוש לפי אסמכתת בקשה"></label><button type="submit" class="button secondary">חיפוש</button><a href="/requests">ניקוי</a></form><section class="panel">${requestTable(requests)}<div class="pagination">${page > 0 ? `<a href="/requests?page=${page - 1}&amp;reference=${encodeURIComponent(reference)}">לעמוד הקודם</a>` : ''}${hasMore ? `<a href="/requests?page=${page + 1}&amp;reference=${encodeURIComponent(reference)}">לעמוד הבא</a>` : ''}</div></section>`,
    session,
    '/requests',
  );
}
export function payloadDetails(p: Submission) {
  const fields: [string, string][] = [
    ['סוג בקשה', kinds[p.kind]],
    ['אסמכתת בקשה', p.reference],
  ];
  if (p.kind === 'invoice_receipt')
    fields.push(
      ['לקוח לדוגמה', customers[p.customer]],
      ['אמצעי תשלום לדוגמה', payments[p.payment]],
      ['אסמכתת תשלום', p.paymentReference],
    );
  if (p.kind !== 'supplier')
    fields.push(
      ['תאריך', p.date],
      ['פריט לדוגמה', products[p.product]],
      ['כמות', String(p.quantity)],
      ['מחיר יחידה לדוגמה', `${(p.unitPrice / 100).toFixed(2)} ₪`],
      ['סכום לדוגמה (ללא חישוב מס)', `${((p.quantity * p.unitPrice) / 100).toFixed(2)} ₪`],
    );
  if (p.kind === 'purchase_order')
    fields.push([
      'ספק',
      p.supplier === 'new' ? 'בקשה לספק חדש ולהזמנת רכש' : suppliers[p.supplier],
    ]);
  if (p.kind === 'supplier' || (p.kind === 'purchase_order' && p.supplier === 'new'))
    fields.push(
      ['שם ספק לדוגמה', p.supplierName],
      ['מספר עוסק לדוגמה', p.registrationNumber],
      ['איש קשר', p.contactName],
      ['דוא״ל', p.email],
    );
  if (p.notes) fields.push(['הערות', p.notes]);
  return fields
    .map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`)
    .join('');
}
export function detail(
  r: SavedRequest,
  session: Session,
  duplicate: boolean,
  events: Record<string, unknown>[],
) {
  const actions: Record<string, string> = {
    request_saved: 'הבקשה נשמרה באתר',
    duplicate_prevented: 'שליחה חוזרת זוהתה — הוחזרה הבקשה הקיימת',
    request_viewed: 'התוצאה נקראה',
    approval_blocked: 'ניסיון אישור נחסם',
    execution_blocked: 'ניסיון ביצוע נחסם',
  };
  return layout(
    'תוצאת בקשה',
    `<a class="back" href="/requests">→ חזרה לבקשות שלי</a><div class="eyebrow">תוצאת שמירה · דמה</div><h1>הבקשה נשמרה באתר</h1><p class="muted">${escapeHtml(r.payload.reference)} · ${kinds[r.payload.kind]}</p>${duplicate ? '<div class="banner" role="status">זוהתה שליחה חוזרת. מוצגת הבקשה הקיימת; לא נוצרה בקשה נוספת.</div>' : ''}<div class="notice" role="status"><strong>${escapeHtml(r.result.message)}</strong><br>${escapeHtml(r.result.approval)}</div><section class="panel"><h2>פרטי המעקב</h2><dl class="details"><div><dt>מזהה בקשה קבוע באתר</dt><dd class="mono" id="request-id">${r.id}</dd></div><div><dt>גרסת הבקשה</dt><dd>${r.version} · התוכן שנשלח נעול לשינוי</dd></div><div><dt>מצב</dt><dd>נשמרה באתר בלבד · לא בוצעה ב־Priority</dd></div><div><dt>מזהי רשומות ב־Priority</dt><dd>אין — לא נוצרו ולא אומתו רשומות</dd></div><div class="wide"><dt>טביעת תוכן לגרסה זו</dt><dd class="mono">${r.contentHash}</dd></div></dl></section><section class="panel"><h2>תוכן הבקשה שנשמר</h2><dl class="details">${payloadDetails(r.payload)}</dl></section><section class="panel"><h2>יומן פעולות</h2><div class="table-wrap"><table><thead><tr><th scope="col">זמן</th><th scope="col">פעולה</th></tr></thead><tbody>${events.map((e) => `<tr><td>${new Date(Number(e.at)).toLocaleString('he-IL', { timeZone: 'Asia/Jerusalem' })}</td><td>${escapeHtml(actions[String(e.action)] ?? 'פעולה תועדה')}</td></tr>`).join('')}</tbody></table></div></section><div class="actions"><a class="button" href="/requests">לכל הבקשות</a><a href="/">הכנת בקשה נוספת</a></div>`,
    session,
    '/requests',
  );
}
export function errorPage(message: string, session?: Session) {
  const body = `<h1>לא ניתן להשלים את הפעולה</h1><div class="notice error" role="alert">${escapeHtml(message)}</div><a href="${session ? '/requests' : '/login'}">חזרה ל${session ? 'בקשות שלי' : 'כניסה'}</a>`;
  return session
    ? layout('הפעולה נחסמה', body, session)
    : document('הפעולה נחסמה', `<main id="main">${body}</main>`);
}
