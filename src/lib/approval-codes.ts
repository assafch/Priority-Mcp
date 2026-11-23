import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Approval codes for the irreversible import steps (phase C): receipt final, file close, release
 * final, costing.
 *
 * A tool's preview issues a short code bound to three things: the tool, the document (subject)
 * and a fingerprint of the state the preview showed. The real run must bring that code back; it
 * is refused when the code is unknown, expired, already used, issued by another tool or for
 * another document, or when the document changed since the preview. So a real run is always
 * preceded by a preview, and only what the preview showed can run.
 *
 * The code does not prove the owner approved: an agent can pass it on by itself. The tools say so
 * in every preview ("pass the code only after the owner saw this preview and approved it in
 * chat"). Codes live in files, not in memory: the preview and the run may reach different
 * processes of the server on the same machine.
 */
export const APPROVAL_TTL_MS = 600_000;

export const DEFAULT_APPROVAL_DIR = fileURLToPath(
  new URL('../../output/import-approvals', import.meta.url),
);

/** No 0/O, 1/I: the code is read and typed by people. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_FORMAT = /^[A-Z2-9]{4}-[A-Z2-9]{4}$/;

export interface ApprovalBinding {
  tool: string;
  /** the document the code is for, e.g. 'IM1/BD1'; 'COMPANY' for the costing */
  subject: string;
  /** what the preview showed; compared as a fingerprint */
  state: unknown;
}

export type ApprovalCheck = { ok: true } | { ok: false; reason: string };

interface StoredApproval {
  tool: string;
  subject: string;
  fingerprint: string;
  issuedAt: string;
  expiresAt: number;
}

/** JSON with object keys sorted at every level, so equal states always print the same. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

export function fingerprintOf(state: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(state ?? null)))
    .digest('hex')
    .slice(0, 16);
}

function newCode(): string {
  const bytes = randomBytes(8);
  const chars = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]);
  return `${chars.slice(0, 4).join('')}-${chars.slice(4).join('')}`;
}

/** Issue a code for what a preview just showed. Throws when the code cannot be stored. */
export function issueApproval(
  dir: string,
  binding: ApprovalBinding,
  now: number,
): { approvalCode: string; approvalExpiresAt: string } {
  mkdirSync(dir, { recursive: true });
  const stored: StoredApproval = {
    tool: binding.tool,
    subject: binding.subject,
    fingerprint: fingerprintOf(binding.state),
    issuedAt: new Date(now).toISOString(),
    expiresAt: now + APPROVAL_TTL_MS,
  };
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = newCode();
    let fd: number;
    try {
      fd = openSync(join(dir, `${code}.json`), 'wx', 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') continue;
      throw err;
    }
    try {
      writeSync(fd, JSON.stringify(stored));
    } finally {
      closeSync(fd);
    }
    return { approvalCode: code, approvalExpiresAt: new Date(stored.expiresAt).toISOString() };
  }
  throw new Error('Could not issue an approval code.');
}

const RERUN = 'מריצים תצוגה מקדימה חדשה (dryRun=true) ומציגים אותה לבעלים.';

function judge(
  dir: string,
  b: ApprovalBinding & { code: string },
  now: number,
): { ok: true; file: string } | { ok: false; reason: string } {
  if (!CODE_FORMAT.test(b.code)) {
    return { ok: false, reason: `קוד האישור "${b.code.slice(0, 20)}" אינו מוכר. ${RERUN}` };
  }
  const file = join(dir, `${b.code}.json`);
  let stored: StoredApproval;
  try {
    stored = JSON.parse(readFileSync(file, 'utf8')) as StoredApproval;
  } catch {
    if (existsSync(join(dir, `${b.code}.used`))) {
      return { ok: false, reason: `קוד האישור ${b.code} כבר נוצל. ${RERUN}` };
    }
    return { ok: false, reason: `קוד האישור ${b.code} אינו מוכר בשרת הזה. ${RERUN}` };
  }
  if (stored.tool !== b.tool || stored.subject !== b.subject) {
    return {
      ok: false,
      reason: `קוד האישור ${b.code} אינו שייך לפעולה הזו (הוא הונפק ל-${stored.tool} על ${stored.subject}). ${RERUN}`,
    };
  }
  if (now > stored.expiresAt) {
    return {
      ok: false,
      reason: `תוקף קוד האישור ${b.code} פג ב-${new Date(stored.expiresAt).toISOString()}. ${RERUN}`,
    };
  }
  if (stored.fingerprint !== fingerprintOf(b.state)) {
    return {
      ok: false,
      reason: `המסמך השתנה מאז התצוגה המקדימה, ולכן קוד האישור ${b.code} אינו תקף לו. ${RERUN}`,
    };
  }
  return { ok: true, file };
}

/** Would this code be accepted now? Does not spend it. */
export function checkApproval(
  dir: string,
  b: ApprovalBinding & { code: string },
  now: number,
): ApprovalCheck {
  const r = judge(dir, b, now);
  return r.ok ? { ok: true } : r;
}

/**
 * Spend the code: accepted once, then never again. Call it as the very last thing before the
 * write or the program is dispatched — a refusal before it leaves the code usable.
 */
export function consumeApproval(
  dir: string,
  b: ApprovalBinding & { code: string },
  now: number,
): ApprovalCheck {
  const r = judge(dir, b, now);
  if (!r.ok) return r;
  try {
    renameSync(r.file, join(dir, `${b.code}.used`));
  } catch {
    // another call spent it between the read and the rename
    return { ok: false, reason: `קוד האישור ${b.code} כבר נוצל. ${RERUN}` };
  }
  return { ok: true };
}
